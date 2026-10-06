'use strict';

/**
 * @typedef SQSRecord
 * @property {string} messageId
 * @property {string} body
 * @property {string} receiptHandle
 * @property {string} eventSourceARN
 * @property {Object<string, string|number>} messageAttributes
 */

/**
 * @typedef ParsedSQSRecord
 * @property {string} messageId
 * @property {object} body
 * @property {string} receiptHandle
 * @property {string} eventSourceARN
 * @property {Object<string, string|number>} messageAttributes
 */

/**
 * @typedef ParsedSQSRecordWithLogger
 * @property {string} messageId
 * @property {object} body
 * @property {string} receiptHandle
 * @property {string} eventSourceARN
 * @property {Object<string, string|number>} messageAttributes
 * @property {LogTransport} Symbol\.for('logger')
 */

/**
 * @typedef SQSEvent
 * @property {Array<SQSRecord>} Records
 */

/**
 * @typedef SQSRecordAndLoggerReadyToProcess
 * @property {ParsedSQSRecord|ParsedSQSRecordWithLogger} preparedRecord
 * @property {string} clientCode
 * @property {LogTransport} logger
 */

/**
 * @typedef BatchItemFailure
 * @property {string} itemIdentifier
 */

const { struct } = require('@janiscommerce/superstruct');

const Events = require('@janiscommerce/events');
const Log = require('@janiscommerce/log');
const lllog = require('lllog')();

const S3Downloader = require('./helpers/s3-downloader');
const RetryBackoff = require('./helpers/retry-backoff');

const LogTransport = require('./log-transport');

const { SQSEventStruct } = require('./structs');

/**
 * Minimum version of sls-helper-plugin-janis that grants sqs:ChangeMessageVisibility. Confirm it on the plugin release.
 */
const MIN_PLUGIN_VERSION = '11.6.0';

const MAX_LOGGED_FAILURES = 5;

/**
 * @typedef {object} BackoffContainerState
 * @property {boolean} enabled
 * @property {import('./helpers/retry-backoff').RetryBackoffConfig} [config]
 * @property {boolean} fifoWarned
 */

/**
 * Retry backoff state by Consumer class. It lives as long as the container (process), across invocations.
 *
 * @type {WeakMap<Function, BackoffContainerState>}
 */
let backoffStates = new WeakMap();

module.exports = class SQSHandler {

	/**
	 * Lambda handler.
	 *
	 * @example module.exports.handler = (event, context) => SQSHandler.handle(MyConsumer, event, context);
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {SQSEvent} event
	 * @param {object} [context] The Lambda context
	 */
	static async handle(Consumer, event, context) {

		process.env.AWS_LAMBDA_REQUEST_ID = context?.awsRequestId || '';

		this.resetFailedResults();

		SQSEventStruct(event);

		Log.start();

		const consumerInstance = new Consumer();

		const isBatch = consumerInstance.handlesBatch(event);

		try {

			if(isBatch)
				await this.handleBatch(Consumer, event);
			else
				await this.handleSingle(Consumer, event);

			await Events.emit('janiscommerce.ended');

		} catch(err) {
			await Events.emit('janiscommerce.ended');
			throw err;
		}

		if(!this.results.length)
			return;

		await this.applyRetryBackoff(Consumer, consumerInstance, event);

		return { batchItemFailures: this.results };
	}

	static resetFailedResults() {
		/** @type {BatchItemFailure[]} */
		this.results = [];
		/** @type {Array<{messageId: string, minDelaySeconds?: number}>} */
		this.failedMessageDelays = [];
	}

	/**
	 * Clears the retry backoff state of the container. Meant for tests.
	 */
	static resetRetryBackoffState() {
		backoffStates = new WeakMap();
	}

	/**
	 * @param {string} messageId SQS Message ID
	 * @param {object} [options]
	 * @param {number} [options.minDelaySeconds] Minimum visibility delay of the retry. Only used with `retryBackoff`
	 */
	static addFailedMessage(messageId, { minDelaySeconds } = {}) {
		this.results.push({ itemIdentifier: messageId });
		this.failedMessageDelays.push({ messageId, minDelaySeconds });
	}

	/**
	 * Gets the retry backoff state of the container, reading and validating the `retryBackoff` getter the first time.
	 * A getter that throws is handled as an invalid config.
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {import('./sqs-consumer')} consumerInstance
	 * @returns {BackoffContainerState}
	 */
	static getBackoffState(Consumer, consumerInstance) {

		if(backoffStates.has(Consumer))
			return backoffStates.get(Consumer);

		let state;

		try {

			const { retryBackoff } = consumerInstance;

			if(retryBackoff === undefined)
				state = { enabled: false, fifoWarned: false };
			else {
				const { valid, config, reason } = RetryBackoff.normalizeConfig(retryBackoff);

				if(!valid)
					lllog.error(`Invalid retryBackoff config, backoff disabled: ${reason}`);

				state = { enabled: valid, config, fifoWarned: false };
			}

		} catch(err) {
			lllog.error(`Invalid retryBackoff config, backoff disabled: the retryBackoff getter threw: ${err.message}`);
			state = { enabled: false, fifoWarned: false };
		}

		backoffStates.set(Consumer, state);

		return state;
	}

	/**
	 * Delays the retry of the failed messages changing their visibility. Never throws.
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {import('./sqs-consumer')} consumerInstance
	 * @param {SQSEvent} event
	 * @returns {Promise<void>}
	 */
	static async applyRetryBackoff(Consumer, consumerInstance, event) {

		const state = this.getBackoffState(Consumer, consumerInstance);

		if(!state.enabled)
			return;

		const { accessDenied, fifo, failures, summary } = await RetryBackoff.applyRetryBackoff(
			event.Records,
			this.failedMessageDelays,
			state.config
		);

		if(accessDenied) {
			state.enabled = false;
			lllog.error(`retryBackoff requires sqs:ChangeMessageVisibility: update sls-helper-plugin-janis >= ${MIN_PLUGIN_VERSION}`);
		}

		if(fifo && !state.fifoWarned) {
			state.fifoWarned = true;
			lllog.warn('retryBackoff is not supported in FIFO queues, the visibility of the messages is not changed');
		}

		if(failures.length) {
			lllog.warn(`retryBackoff could not change the visibility of ${failures.length} messages`, {
				failures: failures.slice(0, MAX_LOGGED_FAILURES),
				...failures.length > MAX_LOGGED_FAILURES && { omittedFailures: failures.length - MAX_LOGGED_FAILURES }
			});
		}

		if(summary.applied > 0 || summary.failures > 0)
			lllog.info('retryBackoff applied', summary);
	}

	/**
	 * Process records in batch but splitting by client or without client
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {SQSEvent} event
	 * @param {boolean} isBatch
	 * @returns {Promise<void>}
	 */
	static async handleBatch(Consumer, event, isBatch = true) {

		const recordsWithoutClient = [];
		const recordsWithClient = {};
		const consumerWithoutClient = new Consumer(this);
		const completeBodiesFromS3 = [];

		for(const record of event.Records) {

			const { preparedRecord, clientCode } = this.prepareRecord(consumerWithoutClient, record, isBatch);

			const { contentS3Location } = preparedRecord.body;

			if(contentS3Location && Object.keys(contentS3Location).length) {
				completeBodiesFromS3.push(
					S3Downloader.downloadContentS3Location(contentS3Location).then(completeBody => { preparedRecord.body = completeBody; })
				);
			}

			if(clientCode) {

				if(!recordsWithClient[clientCode])
					recordsWithClient[clientCode] = [];

				recordsWithClient[clientCode].push(preparedRecord);

			} else
				recordsWithoutClient.push(preparedRecord);

		}

		await Promise.all(completeBodiesFromS3);

		const batches = [];

		if(recordsWithoutClient.length)
			batches.push(consumerWithoutClient.processBatch(recordsWithoutClient));

		if(Object.keys(recordsWithClient).length) {
			Object.entries(recordsWithClient).forEach(([clientCode, clientRecords]) => {
				const consumer = new Consumer(this);
				consumer.setSession({ clientCode });
				batches.push(consumer.processBatch(clientRecords));
			});
		}

		return Promise.all(batches);
	}

	/**
	 * Process records one by one
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {SQSEvent} event
	 * @param {boolean} isBatch
	 * @returns {Promise<void>}
	 */
	static async handleSingle(Consumer, event, isBatch = false) {

		return Promise.all(event.Records.map(async record => {

			const consumer = new Consumer(this);

			const { preparedRecord, logger, clientCode } = this.prepareRecord(consumer, record, isBatch);

			const { contentS3Location } = preparedRecord.body;

			if(contentS3Location && Object.keys(contentS3Location).length) {

				const completeBody = await S3Downloader.downloadContentS3Location(contentS3Location);

				preparedRecord.body = completeBody;
			}

			if(clientCode)
				consumer.setSession({ clientCode });

			return consumer.processSingleRecord(preparedRecord, logger);
		}));
	}

	/**
	 * @throws If record body is not a valid JSON
	 * @param {SQSRecord} record
	 * @returns {ParsedSQSRecord} The record with the body parsed as JSON
	 */
	static parseRecord(record) {

		const { body, ...rest } = record;

		return {
			...rest,
			body: JSON.parse(body)
		};

	}

	/**
	 * Validates the struct if it's defined
	 *
	 * @param {import('./sqs-consumer')} consumer
	 * @param {SQSRecord} record
	 * @return {SQSRecord} The validated record
	 */
	static validateRecordStruct(consumer, record) {

		if(!consumer.struct)
			return record;

		const args = !Array.isArray(consumer.struct) ? [consumer.struct] : consumer.struct;

		const Schema = struct(...args);

		const { body: bodyRecord, ...argsRecord } = record;

		const [error, parsed] = Schema.validate(bodyRecord);

		if(error)
			throw new Error(error.reason || error.message);

		return { body: parsed, ...argsRecord };
	}

	/**
	 * Prepare record to process in handler
	 *
	 * @param {import('./sqs-consumer')} consumer
	 * @param {SQSRecord} record
	 * @param {boolean} isBatch
	 * @returns {SQSRecordAndLoggerReadyToProcess} Ready to process
	 */
	static prepareRecord(consumer, record, isBatch) {

		const parsedRecord = this.parseRecord(record);
		const logger = new LogTransport(record.messageId);
		const clientCode = this.getClient(record.messageAttributes);
		const preparedRecord = this.validateRecordStruct(consumer, parsedRecord);

		if(isBatch)
			preparedRecord[Symbol.for('logger')] = logger;

		return {
			preparedRecord,
			clientCode,
			logger
		};
	}

	/**
	 * Extract the client code from messageAttributes
	 *
	 * @param {SQSRecord.messageAttributes} messageAttributes
	 * @returns {string | undefined} The client code or undefined if janis-client messageAttribute is not present
	 */
	static getClient(messageAttributes) {

		if(!messageAttributes || !messageAttributes['janis-client'])
			return;

		const { stringValue: clientCode } = messageAttributes['janis-client'];

		return clientCode;
	}
};
