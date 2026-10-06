'use strict';

const { struct } = require('@janiscommerce/superstruct');

/**
 * @typedef {object} BackoffConfig
 * @property {number} baseDelaySeconds
 * @property {number} maxDelaySeconds
 * @property {number} jitterRatio
 */

/**
 * @typedef {object} NormalizedConfig
 * @property {boolean} valid
 * @property {boolean} [disabled] The config turns the backoff off (`undefined`, `null` or `false`)
 * @property {BackoffConfig} [config] Present when valid and not disabled
 * @property {string} [reason] Present when invalid
 */

module.exports = class RetryBackoffConfig {

	/**
	 * @return {BackoffConfig}
	 */
	static get defaults() {
		return {
			baseDelaySeconds: 60,
			maxDelaySeconds: 900,
			jitterRatio: 0.2
		};
	}

	/**
	 * 12 hours (SQS max visibility) minus 15 minutes (Lambda max timeout).
	 * SQS counts the 12 hours since the message was received, so the visibility change must leave room for the processing time.
	 *
	 * @return {number}
	 */
	static get maxAllowedDelaySeconds() {
		return 42300;
	}

	/**
	 * Applies defaults to the missing fields and validates the config. Never throws.
	 * `undefined`, `null` and `false` turn the backoff off. `true` turns it on with the defaults, like `{}`.
	 *
	 * @param {Partial<BackoffConfig>|boolean|null} [config] The value returned by the `retryBackoff` getter
	 * @return {NormalizedConfig}
	 */
	static normalize(config) {

		if(config === undefined || config === null || config === false)
			return { valid: true, disabled: true };

		const [error, normalizedConfig] = this.struct.validate(config === true ? {} : config);

		if(error)
			return { valid: false, reason: this.getReason(error) };

		// Cross-field rule: a struct validates each field on its own
		if(normalizedConfig.baseDelaySeconds > normalizedConfig.maxDelaySeconds)
			return { valid: false, reason: 'baseDelaySeconds must not be greater than maxDelaySeconds' };

		return { valid: true, config: normalizedConfig };
	}

	static get struct() {

		const { maxAllowedDelaySeconds: maxAllowed } = this;

		return struct.partial({
			baseDelaySeconds: this.numberValidator('baseDelaySeconds', value => value > 0, 'must be greater than 0'),
			maxDelaySeconds: this.numberValidator('maxDelaySeconds', value => value <= maxAllowed, `must not be greater than ${maxAllowed}`),
			jitterRatio: this.numberValidator('jitterRatio', value => value >= 0 && value < 1, 'must be in the range [0, 1)')
		}, this.defaults);
	}

	/**
	 * Builds a struct validator that returns `true` or the reason of the failure.
	 *
	 * @param {string} field
	 * @param {function(number): boolean} isInRange
	 * @param {string} rangeRule
	 * @return {function(*): (true|string)}
	 */
	static numberValidator(field, isInRange, rangeRule) {
		return value => {

			if(!Number.isFinite(value))
				return `${field} must be a finite number`;

			return isInRange(value) || `${field} ${rangeRule}`;
		};
	}

	/**
	 * A failure without path is the root value: not an object.
	 *
	 * @param {{path: Array<string>, reason: string}} error The struct error
	 * @return {string}
	 */
	static getReason({ path, reason }) {
		return path.length ? reason : 'retryBackoff must be an object';
	}
};
