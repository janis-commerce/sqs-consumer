'use strict';

/**
 * @typedef {import('./sqs-handler').ParsedSQSRecord} ParsedSQSRecord
 * @typedef {import('./log-transport')} LogTransport
 */

module.exports = class SQSConsumer {

	/**
	 * Indicates whether the consumer processes the whole batch or each record one by one
	 *
	 * @returns {boolean}
	 */
	handlesBatch() {
		return false;
	}

	/**
	 * Process a whole batch of records. Each record have an injected property with the logger.
	 * For example, to log an error use `record[Symbol.for('logger')].error('Some error message');
	 *
	 * @param {Array<ParsedSQSRecord>} records
	 */
	// eslint-disable-next-line no-unused-vars,no-empty-function
	async processBatch(records) {}

	/**
	 * Process a whole batch of records
	 *
	 * @param {ParsedSQSRecord} record
	 * @param {LogTransport} logger
	 */
	// eslint-disable-next-line no-unused-vars,no-empty-function
	async processSingleRecord(record, logger) {}

};
