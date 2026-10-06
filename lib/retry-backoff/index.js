'use strict';

const lllog = require('lllog')();

const RetryBackoffConfig = require('./config');
const RetryDelay = require('./delay');
const VisibilityChanger = require('./visibility-changer');
const QueueArn = require('../helpers/queue-arn');

/**
 * @typedef {import('./config').BackoffConfig} BackoffConfig
 * @typedef {import('./visibility-changer').VisibilityChange} VisibilityChange
 * @typedef {import('./visibility-changer').VisibilityFailure} VisibilityFailure
 */

/**
 * @typedef {object} FailedMessage
 * @property {string} messageId
 * @property {number} [minDelaySeconds]
 * @property {number} [delaySeconds] Exact delay. Replaces the formula and the floor, only capped
 */

/**
 * @typedef {object} ContainerState
 * @property {boolean} enabled
 * @property {BackoffConfig} [config]
 * @property {boolean} fifoWarned
 */

/**
 * @typedef {object} BackoffSummary
 * @property {number} applied Messages whose visibility was requested to change
 * @property {number} failures Messages whose visibility could not be changed (includes skipped ones)
 * @property {number|null} minAttempt
 * @property {number|null} maxAttempt
 * @property {number|null} minDelay
 * @property {number|null} maxDelay
 */

/**
 * @typedef {object} BackoffResult
 * @property {boolean} accessDenied Some call or entry was denied: the backoff must be disabled
 * @property {boolean} fifo Some message belongs to a FIFO queue and was skipped
 * @property {Array<VisibilityFailure>} failures
 * @property {BackoffSummary} summary
 */

/**
 * @typedef {object} ChangesPlan
 * @property {Array<VisibilityChange>} changes
 * @property {Array<VisibilityFailure>} failures Messages skipped before calling SQS
 * @property {boolean} fifo
 */

/**
 * @typedef {object} PlannedMessage Has one of its properties
 * @property {VisibilityChange} [change]
 * @property {VisibilityFailure} [failure]
 * @property {boolean} [fifo] The message belongs to a FIFO queue and is skipped
 */

module.exports = class RetryBackoff {

	/**
	 * Minimum version of sls-helper-plugin-janis that grants sqs:ChangeMessageVisibility. Confirm it on the plugin release.
	 *
	 * @return {string}
	 */
	static get minPluginVersion() {
		return '11.6.0';
	}

	static get maxLoggedFailures() {
		return 5;
	}

	static get errorCodes() {
		return {
			recordNotFound: 'RecordNotFound',
			invalidQueue: 'InvalidEventSourceARN'
		};
	}

	/**
	 * State of the container (process), across invocations. A Lambda runs a single Consumer.
	 *
	 * @type {ContainerState|null}
	 */
	static state = null;

	/**
	 * Gets the attempt of a SQS record: its `ApproximateReceiveCount`. Missing or invalid counts are the first attempt.
	 *
	 * @param {object} record The SQS record
	 * @return {number} The attempt, 1-based
	 */
	static getAttempt(record) {
		return RetryDelay.getAttempt(record);
	}

	/**
	 * Calculates the delay of a retry, the same one the consumer applies with the `retryBackoff` getter:
	 * `base × 2^(attempt − 1)`, with a ±`jitterRatio` jitter, floored by `minDelaySeconds`, capped by `maxDelaySeconds` and
	 * never lower than 1 second.
	 *
	 * @param {number} attempt The attempt that failed, 1-based. Invalid values are the first attempt.
	 * @param {Partial<BackoffConfig>|boolean|null} [config] Same shape as the `retryBackoff` getter. Missing fields take the defaults
	 * @param {number} [minDelaySeconds] Minimum delay
	 * @return {number} The delay in seconds, integer
	 * @throws {Error} If the config is invalid
	 */
	static getRetryDelaySeconds(attempt, config, minDelaySeconds) {

		const { valid, config: normalizedConfig, reason } = RetryBackoffConfig.normalize(config);

		if(!valid)
			throw new Error(`Invalid retryBackoff config: ${reason}`);

		return RetryDelay.calculate(attempt, normalizedConfig || RetryBackoffConfig.defaults, { minDelaySeconds });
	}

	/**
	 * Delays the retry of the failed messages changing their visibility. Logs the outcome.
	 * Only throws on unexpected errors: the caller must catch them.
	 *
	 * @param {import('../sqs-consumer')} consumerInstance Provides the `retryBackoff` getter
	 * @param {Array<object>} records The `event.Records` of the invocation
	 * @param {Array<FailedMessage>} failedMessages
	 * @return {Promise<void>}
	 */
	static async apply(consumerInstance, records, failedMessages) {

		const state = this.getState(consumerInstance);

		if(!state.enabled)
			return;

		const { accessDenied, fifo, failures, summary } = await this.delayRetries(records, failedMessages, state.config);

		if(accessDenied)
			this.disable();

		if(fifo)
			this.warnFifo();

		if(failures.length)
			this.logFailures(failures);

		if(summary.applied > 0 || summary.failures > 0)
			lllog.info('retryBackoff applied', summary);
	}

	/**
	 * Reads and validates the `retryBackoff` getter the first time. A getter that throws is handled as an invalid config.
	 *
	 * @param {import('../sqs-consumer')} consumerInstance
	 * @return {ContainerState}
	 */
	static getState(consumerInstance) {

		this.state ??= this.buildState(consumerInstance);

		return this.state;
	}

	/**
	 * @param {import('../sqs-consumer')} consumerInstance
	 * @return {ContainerState}
	 */
	static buildState(consumerInstance) {

		try {

			const { valid, disabled, config, reason } = RetryBackoffConfig.normalize(consumerInstance.retryBackoff);

			if(!valid)
				lllog.error(`Invalid retryBackoff config, backoff disabled: ${reason}`);

			return { enabled: valid && !disabled, config, fifoWarned: false };

		} catch(err) {
			lllog.error(`Invalid retryBackoff config, backoff disabled: the retryBackoff getter threw: ${err.message}`);
			return { enabled: false, fifoWarned: false };
		}
	}

	/**
	 * Messages of FIFO queues are skipped. A repeated `messageId` keeps the options of the last one.
	 *
	 * @param {Array<object>} records The `event.Records` of the invocation
	 * @param {Array<FailedMessage>} failedMessages
	 * @param {BackoffConfig} config A valid normalized config
	 * @return {Promise<BackoffResult>}
	 */
	static async delayRetries(records, failedMessages, config) {

		const { changes, failures, fifo } = this.planChanges(records, failedMessages, config);

		const { accessDenied, failures: visibilityFailures } = await VisibilityChanger.change(changes);

		failures.push(...visibilityFailures);

		return {
			accessDenied,
			fifo,
			failures,
			summary: this.buildSummary(changes, failures)
		};
	}

	/**
	 * @param {Array<object>} records
	 * @param {Array<FailedMessage>} failedMessages
	 * @param {BackoffConfig} config
	 * @return {ChangesPlan}
	 */
	static planChanges(records, failedMessages, config) {

		const recordsByMessageId = {};

		(records || []).forEach(record => {
			recordsByMessageId[record.messageId] = record;
		});

		// A repeated messageId keeps a single change: the last one
		const changesByMessageId = {};
		const failures = [];
		let fifo = false;

		failedMessages.forEach(({ messageId, ...options }) => {

			const plannedMessage = this.planMessage(messageId, recordsByMessageId[messageId], options, config);

			if(plannedMessage.change)
				changesByMessageId[messageId] = plannedMessage.change;
			else if(plannedMessage.failure)
				failures.push(plannedMessage.failure);
			else
				fifo = true;
		});

		return { changes: Object.values(changesByMessageId), failures, fifo };
	}

	/**
	 * @param {string} messageId
	 * @param {object} [record] The SQS record of the message
	 * @param {Omit<FailedMessage, 'messageId'>} options
	 * @param {BackoffConfig} config
	 * @return {PlannedMessage}
	 */
	static planMessage(messageId, record, options, config) {

		if(!record)
			return { failure: { messageId, errorCode: this.errorCodes.recordNotFound } };

		const queue = QueueArn.parse(record.eventSourceARN);

		if(!queue)
			return { failure: { messageId, errorCode: this.errorCodes.invalidQueue } };

		if(queue.fifo)
			return { fifo: true };

		const attempt = RetryDelay.getAttempt(record);

		return {
			change: {
				messageId,
				receiptHandle: record.receiptHandle,
				queueUrl: queue.queueUrl,
				region: queue.region,
				attempt,
				delaySeconds: RetryDelay.calculate(attempt, config, options)
			}
		};
	}

	/**
	 * @param {Array<VisibilityChange>} changes
	 * @param {Array<VisibilityFailure>} failures
	 * @return {BackoffSummary}
	 */
	static buildSummary(changes, failures) {

		const summary = {
			applied: changes.length,
			failures: failures.length,
			minAttempt: null,
			maxAttempt: null,
			minDelay: null,
			maxDelay: null
		};

		changes.forEach(({ attempt, delaySeconds }) => {
			summary.minAttempt = Math.min(summary.minAttempt ?? attempt, attempt);
			summary.maxAttempt = Math.max(summary.maxAttempt ?? attempt, attempt);
			summary.minDelay = Math.min(summary.minDelay ?? delaySeconds, delaySeconds);
			summary.maxDelay = Math.max(summary.maxDelay ?? delaySeconds, delaySeconds);
		});

		return summary;
	}

	static disable() {
		this.state.enabled = false;
		lllog.error(`retryBackoff requires sqs:ChangeMessageVisibility: update sls-helper-plugin-janis >= ${this.minPluginVersion}`);
	}

	static warnFifo() {

		if(this.state.fifoWarned)
			return;

		this.state.fifoWarned = true;
		lllog.warn('retryBackoff is not supported in FIFO queues, the visibility of the messages is not changed');
	}

	/**
	 * @param {Array<VisibilityFailure>} failures
	 */
	static logFailures(failures) {

		const { maxLoggedFailures } = this;

		lllog.warn(`retryBackoff could not change the visibility of ${failures.length} messages`, {
			failures: failures.slice(0, maxLoggedFailures),
			...failures.length > maxLoggedFailures && { omittedFailures: failures.length - maxLoggedFailures }
		});
	}

	/**
	 * Clears the state of the container. Meant for tests.
	 */
	static resetState() {
		this.state = null;
	}
};
