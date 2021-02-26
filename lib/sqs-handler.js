'use strict';

/**
 * @typedef SQSRecord
 * @property {string} messageId
 * @property {string} body
 * @property {Object<string, string|number>} messageAttributes
 */

/**
 * @typedef ParsedSQSRecord
 * @property {string} messageId
 * @property {object} body
 * @property {Object<string, string|number>} messageAttributes
 */

/**
 * @typedef SQSEvent
 * @property {Array<SQSRecord>} Records
 */

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

		const consumer = new Consumer();
		if(consumer.handlesBatch()) {
			await consumer.processBatch(event.Records.map(record => {
				const parsedRecord = this.parseRecord(record);
				const logger = new LogTransport(record.messageId);
				parsedRecord[Symbol.for('logger')] = logger;
				return parsedRecord;
			}));
		} else {
			await Promise.all(event.Records.map(record => {
				const logger = new LogTransport(record.messageId);
				return consumer.processSingleRecord(this.parseRecord(record), logger);
			}));
		}

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

};
