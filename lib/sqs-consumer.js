'use strict';

/**
 * @typedef {import('./sqs-handler').ParsedSQSRecord} ParsedSQSRecord
 * @typedef {import('./sqs-handler').ParsedSQSRecordWithLogger} ParsedSQSRecordWithLogger
 * @typedef {import('./log-transport')} LogTransport
 */

const { ApiSession } = require('@janiscommerce/api-session');

module.exports = class SQSConsumer {

	constructor(handler) {
		this.handler = handler;
	}

	/**
	 * Opt-in exponential backoff with jitter for the failed messages: the visibility of each one is changed
	 * so it returns to the queue after a nominal delay `N = min(maxDelaySeconds, baseDelaySeconds × 2^(attempt − 1))` with the jitter
	 * of `jitterMode`: `upward` in `[N, N × (1 + jitterRatio))`, `equal` in `[N / 2, N)` and `full` in `[0, N)`.
	 * Missing fields take the defaults: 60 / 900 / 0.2 / `upward`. Not supported in FIFO queues.
	 * Requires the `sqs:ChangeMessageVisibility` permission.
	 *
	 * @returns {Partial<import('./retry-backoff/config').BackoffConfig>|boolean|null|undefined} Undefined, `null` or `false` (default)
	 * disable the backoff. `true` enables it with the defaults
	 */
	get retryBackoff() {
		return undefined;
	}

	/**
	 * @param {string} messageId SQS Message ID
	 * @param {object} [options]
	 * @param {number} [options.minDelaySeconds] Minimum visibility delay of the retry. Only used with `retryBackoff`
	 * @param {number} [options.delaySeconds] Exact visibility delay of the retry, without jitter. Replaces the formula and
	 * `minDelaySeconds`, only capped to `[0, maxDelaySeconds]`. Only used with `retryBackoff`
	 */
	addFailedMessage(messageId, options) {
		this.handler.addFailedMessage(messageId, options);
	}

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
	 * For example, to log an error use `record[Symbol.for('logger')].error('Some error message');`
	 *
	 * @param {Array<ParsedSQSRecordWithLogger>} records
	 */
	// eslint-disable-next-line no-unused-vars,no-empty-function
	async processBatch(records) {}

	/**
	 * Process a single record.
	 *
	 * @param {ParsedSQSRecord} record
	 * @param {LogTransport} logger
	 */
	// eslint-disable-next-line no-unused-vars,no-empty-function
	async processSingleRecord(record, logger) {}

	/**
	 *
	 * @param {ApiSession.AuthenticationData} authenticationData
	 * @returns {ApiSession}
	 */
	setSession(authenticationData) {
		this.session = new ApiSession(authenticationData);
	}
};
