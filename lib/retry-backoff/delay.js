'use strict';

/**
 * @typedef {import('./config').BackoffConfig} BackoffConfig
 */

/**
 * @typedef {object} DelayOptions
 * @property {number} [minDelaySeconds] Minimum delay
 * @property {number} [delaySeconds] Exact delay. Replaces the formula and `minDelaySeconds`, only floored by the base delay and capped
 */

module.exports = class RetryDelay {

	/**
	 * Max visibility timeout of SQS: 12 hours, counted since the message was received (not since the visibility change).
	 *
	 * @return {number}
	 */
	static get maxVisibilityTimeoutSeconds() {
		return 43200;
	}

	/**
	 * Max batching window of a Lambda event source mapping (5 minutes). The message may have waited that long since SQS delivered it,
	 * and the record has no receive time.
	 *
	 * @return {number}
	 */
	static get maxBatchingWindowSeconds() {
		return 300;
	}

	/**
	 * Safety margin for the time between the end of the invocation and the visibility change.
	 *
	 * @return {number}
	 */
	static get safetyMarginSeconds() {
		return 30;
	}

	/**
	 * Gets the attempt of a SQS record: its `ApproximateReceiveCount`. Missing or invalid counts are the first attempt.
	 *
	 * @param {object} record The SQS record
	 * @return {number} The attempt, 1-based
	 */
	static getAttempt(record) {

		const attempt = Number.parseInt(record?.attributes?.ApproximateReceiveCount, 10);

		return this.isValidAttempt(attempt) ? attempt : 1;
	}

	/**
	 * Limits `maxDelaySeconds` to what SQS still accepts in this invocation: the max visibility timeout, minus the batching window,
	 * the seconds elapsed since the invocation started and the safety margin.
	 *
	 * @param {BackoffConfig} config A valid normalized config
	 * @param {number} invocationStartedAt Timestamp in ms of the start of the invocation
	 * @return {BackoffConfig}
	 */
	static limitToInvocation(config, invocationStartedAt) {

		const elapsedSeconds = (Date.now() - invocationStartedAt) / 1000;

		const invocationMaxDelaySeconds = this.maxVisibilityTimeoutSeconds - this.maxBatchingWindowSeconds - elapsedSeconds - this.safetyMarginSeconds;

		return { ...config, maxDelaySeconds: Math.min(config.maxDelaySeconds, invocationMaxDelaySeconds) };
	}

	/**
	 * Calculates the delay of a retry with a valid config. Never throws.
	 * `baseDelaySeconds` is the floor of every delay and `maxDelaySeconds` the cap, so the delay is in `[baseDelaySeconds, maxDelaySeconds]`.
	 * An exact `delaySeconds` replaces the formula and `minDelaySeconds`, without jitter.
	 *
	 * @param {number} attempt The attempt that failed, 1-based. Invalid values are the first attempt.
	 * @param {BackoffConfig} config A valid normalized config
	 * @param {DelayOptions} [options]
	 * @return {number} The delay in seconds, integer
	 */
	static calculate(attempt, { baseDelaySeconds, maxDelaySeconds, jitterRatio }, { minDelaySeconds, delaySeconds } = {}) {

		const floor = Number.isFinite(minDelaySeconds) ? minDelaySeconds : 0;

		const jitteredDelay = this.applyJitter(this.getExponentialDelay(attempt, baseDelaySeconds), jitterRatio);

		const delay = Number.isFinite(delaySeconds) ? delaySeconds : Math.max(floor, jitteredDelay);

		return Math.min(Math.floor(maxDelaySeconds), Math.ceil(Math.max(baseDelaySeconds, delay)));
	}

	/**
	 * For huge attempts 2 ** n is Infinity, and the final cap leaves it in maxDelaySeconds.
	 *
	 * @param {number} attempt
	 * @param {number} baseDelaySeconds
	 * @return {number}
	 */
	static getExponentialDelay(attempt, baseDelaySeconds) {

		const safeAttempt = this.isValidAttempt(attempt) ? attempt : 1;

		return baseDelaySeconds * (2 ** (safeAttempt - 1));
	}

	/**
	 * @param {number} delaySeconds
	 * @param {number} jitterRatio
	 * @return {number} The delay plus a random 0 to `jitterRatio` of it. Never lower
	 */
	static applyJitter(delaySeconds, jitterRatio) {
		return delaySeconds * (1 + (Math.random() * jitterRatio));
	}

	static isValidAttempt(attempt) {
		return Number.isInteger(attempt) && attempt > 0;
	}
};
