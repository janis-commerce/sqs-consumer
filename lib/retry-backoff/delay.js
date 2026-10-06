'use strict';

/**
 * @typedef {import('./config').BackoffConfig} BackoffConfig
 */

/**
 * @typedef {object} DelayOptions
 * @property {number} [minDelaySeconds] Minimum delay
 * @property {number} [delaySeconds] Exact delay. Replaces the formula and the floor, only capped
 */

module.exports = class RetryDelay {

	/**
	 * Min delay of a retry. A 0 visibility would make the message available again immediately.
	 *
	 * @return {number}
	 */
	static get lowestDelaySeconds() {
		return 1;
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
	 * Calculates the delay of a retry with a valid config. Never throws.
	 * An exact `delaySeconds` replaces the formula and the floor, without jitter. The delay is always in `[1, maxDelaySeconds]`.
	 *
	 * @param {number} attempt The attempt that failed, 1-based. Invalid values are the first attempt.
	 * @param {BackoffConfig} config A valid normalized config
	 * @param {DelayOptions} [options]
	 * @return {number} The delay in seconds, integer
	 */
	static calculate(attempt, { baseDelaySeconds, maxDelaySeconds, jitterRatio }, { minDelaySeconds, delaySeconds } = {}) {

		if(Number.isFinite(delaySeconds))
			return this.clamp(delaySeconds, maxDelaySeconds);

		const jitteredDelay = this.applyJitter(this.getExponentialDelay(attempt, baseDelaySeconds), jitterRatio);

		const floor = Number.isFinite(minDelaySeconds) ? minDelaySeconds : 0;

		return this.clamp(Math.max(floor, jitteredDelay), maxDelaySeconds);
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
	 * @return {number} The delay ±`jitterRatio`, rounded
	 */
	static applyJitter(delaySeconds, jitterRatio) {

		const jitterFactor = 1 + (((Math.random() * 2) - 1) * jitterRatio);

		return Math.round(delaySeconds * jitterFactor);
	}

	/**
	 * Applies the floor of 1 second and the cap `maxDelaySeconds`. The result is an integer.
	 *
	 * @param {number} delaySeconds
	 * @param {number} maxDelaySeconds
	 * @return {number}
	 */
	static clamp(delaySeconds, maxDelaySeconds) {
		return Math.max(this.lowestDelaySeconds, Math.min(Math.floor(maxDelaySeconds), Math.ceil(delaySeconds)));
	}

	static isValidAttempt(attempt) {
		return Number.isInteger(attempt) && attempt > 0;
	}
};
