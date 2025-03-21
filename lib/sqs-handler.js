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

const S3Downloader = require('./helpers/s3-downloader');
const ParameterStore = require('./helpers/parameter-store');

const LogTransport = require('./log-transport');

const { SQSEventStruct } = require('./structs');

module.exports = class SQSHandler {

	/**
	 * Lambda handler.
	 *
	 * @example module.exports.handler = event => SQSHandler.handle(MyConsumer, event);
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {SQSEvent} event
	 */
	static async handle(Consumer, event) {

		this.resetFailedResults();

		SQSEventStruct(event);

		Log.start();

		const isBatch = (new Consumer()).handlesBatch(event);

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

		if(this.results.length)
			return { batchItemFailures: this.results };
	}

	static resetFailedResults() {
		/** @type {BatchItemFailure[]} */
		this.results = [];
	}

	/**
	 * @param {string} messageId SQS Message ID
	 */
	static addFailedMessage(messageId) {
		this.results.push({ itemIdentifier: messageId });
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

		for(const record of event.Records) {

			const { preparedRecord, clientCode } = this.prepareRecord(consumerWithoutClient, record, isBatch);

			const { contentS3Path } = preparedRecord.body;

			if(contentS3Path) {

				const bucketList = await ParameterStore.getParameterValue();

				const completeBody = await S3Downloader.downloadContentS3Path(bucketList, contentS3Path);

				preparedRecord.body = completeBody;
			}

			if(clientCode) {

				if(!recordsWithClient[clientCode])
					recordsWithClient[clientCode] = [];

				recordsWithClient[clientCode].push(preparedRecord);

			} else
				recordsWithoutClient.push(preparedRecord);

		}

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
	static handleSingle(Consumer, event, isBatch = false) {

		return Promise.all(event.Records.map(async record => {

			const consumer = new Consumer(this);

			const { preparedRecord, logger, clientCode } = this.prepareRecord(consumer, record, isBatch);

			const { contentS3Path } = preparedRecord.body;

			if(contentS3Path) {

				const bucketList = await ParameterStore.getParameterValue();

				const completeBody = await S3Downloader.downloadContentS3Path(bucketList, contentS3Path);

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
