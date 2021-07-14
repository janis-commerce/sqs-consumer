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

const { struct } = require('@janiscommerce/superstruct');

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

		SQSEventStruct(event);

		const isBatch = (new Consumer()).handlesBatch(event);
		if(isBatch)
			await this.handleBatch(Consumer, event);
		else
			await this.handleSingle(Consumer, event);
	}

	/**
	 * Process records in batch but splitting by client or without client
	 *
	 * @param {import('./sqs-consumer')} Consumer
	 * @param {SQSEvent} event
	 * @param {boolean} isBatch
	 * @returns {Promise}
	 */
	static handleBatch(Consumer, event, isBatch = true) {
		const recordsWithoutClient = [];
		const recordsWithClient = {};
		const consumerWithoutClient = new Consumer();
		event.Records.forEach(record => {
			const { preparedRecord, clientCode } = this.prepareRecord(consumerWithoutClient, record, isBatch);
			if(clientCode) {
				if(!recordsWithClient[clientCode])
					recordsWithClient[clientCode] = [];

				recordsWithClient[clientCode].push(preparedRecord);
			} else
				recordsWithoutClient.push(preparedRecord);
		});

		const batches = [];
		if(recordsWithoutClient.length)
			batches.push(consumerWithoutClient.processBatch(recordsWithoutClient));

		if(Object.keys(recordsWithClient).length) {
			Object.keys(recordsWithClient).forEach(clientCode => {
				const consumer = new Consumer();
				consumer.setSession({ clientCode });
				batches.push(consumer.processBatch(recordsWithClient[clientCode]));
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
	 * @returns {Promise}
	 */
	static handleSingle(Consumer, event, isBatch = false) {
		return Promise.all(event.Records.map(record => {
			const consumer = new Consumer();
			const { preparedRecord, logger, clientCode } = this.prepareRecord(consumer, record, isBatch);

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
	 * Validates the struct if any
	 *
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
	 * @returns {string | undefined}
	 */
	static getClient(messageAttributes) {
		if(!messageAttributes || !messageAttributes['janis-client'])
			return;

		const { stringValue: clientCode } = messageAttributes['janis-client'];

		return clientCode;
	}
};
