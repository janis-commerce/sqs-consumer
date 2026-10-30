'use strict';

/**
 * @typedef {import('./config').BackoffConfig} BackoffConfig
 */

/**
 * @typedef {'upward'|'equal'|'full'} JitterMode
 */

/**
 * @typedef {object} DelayOptions
 * @property {number} [minDelaySeconds] Minimum delay
 * @property {number} [delaySeconds] Exact delay. Replaces the formula and `minDelaySeconds`, without jitter. Only capped to `[0, maxDelaySeconds]`
 */

module.exports = class RetryDelay {

	/**
	 * How the jitter is applied to the nominal delay `N = min(maxDelaySeconds, baseDelaySeconds × 2^(attempt − 1))`:
	 * `upward` in `[N, N × (1 + jitterRatio))`, `equal` in `[N / 2, N)` and `full` in `[0, N)`.
	 *
	 * @return {{upward: 'upward', equal: 'equal', full: 'full'}}
	 */
	static get jitterModes() {
		return {
			upward: 'upward',
			equal: 'equal',
			full: 'full'
		};
	}

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
	 * The nominal delay `baseDelaySeconds × 2^(attempt − 1)` is capped by `maxDelaySeconds` before the jitter of `jitterMode`,
	 * so the retries keep spreading once the formula exceeds the cap. Then it is floored by `minDelaySeconds` and capped again.
	 * An exact `delaySeconds` replaces the formula and `minDelaySeconds`, without jitter. The delay is always in `[0, maxDelaySeconds]`.
	 *
	 * @param {number} attempt The attempt that failed, 1-based. Invalid values are the first attempt.
	 * @param {BackoffConfig} config A valid normalized config
	 * @param {DelayOptions} [options]
	 * @return {number} The delay in seconds, integer
	 */
	static calculate(attempt, { baseDelaySeconds, maxDelaySeconds, jitterRatio, jitterMode }, { minDelaySeconds, delaySeconds } = {}) {

		const floor = Number.isFinite(minDelaySeconds) ? minDelaySeconds : 0;

		const nominalDelay = Math.min(maxDelaySeconds, this.getExponentialDelay(attempt, baseDelaySeconds));

		const jitteredDelay = this.applyJitter(nominalDelay, jitterRatio, jitterMode);

		const delay = Number.isFinite(delaySeconds) ? delaySeconds : Math.max(floor, jitteredDelay);

		return Math.min(Math.floor(maxDelaySeconds), Math.max(0, Math.ceil(delay)));
	}

	/**
	 * For huge attempts 2 ** n is Infinity, and the cap of the nominal delay leaves it in maxDelaySeconds.
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
	 * `jitterRatio` is only used by the `upward` mode.
	 *
	 * @param {number} delaySeconds The nominal delay
	 * @param {number} jitterRatio
	 * @param {JitterMode} [jitterMode] Defaults to `upward`
	 * @return {number} `upward`: in `[delay, delay × (1 + jitterRatio))`. `equal`: in `[delay / 2, delay)`. `full`: in `[0, delay)`
	 */
	static applyJitter(delaySeconds, jitterRatio, jitterMode) {

		if(jitterMode === this.jitterModes.full)
			return Math.random() * delaySeconds;

		if(jitterMode === this.jitterModes.equal)
			return (delaySeconds / 2) + (Math.random() * (delaySeconds / 2));

		return delaySeconds * (1 + (Math.random() * jitterRatio));
	}

	static isValidAttempt(attempt) {
		return Number.isInteger(attempt) && attempt > 0;
	}
};
