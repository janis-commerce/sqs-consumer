'use strict';

/**
 * @typedef {object} QueueData
 * @property {string} queueUrl
 * @property {string} region
 * @property {boolean} fifo
 */

module.exports = class QueueArn {

	/**
	 * Parsed ARNs, by ARN. A container receives messages of very few queues, so it stays small.
	 *
	 * @type {Object<string, QueueData|null>}
	 */
	static cache = {};

	/**
	 * Parses a SQS queue ARN (`arn:aws:sqs:<region>:<accountId>:<queueName>`). The result is cached by ARN.
	 *
	 * @param {string} eventSourceARN
	 * @return {QueueData|null} null when the ARN is not a SQS queue ARN
	 */
	static parse(eventSourceARN) {

		if(typeof eventSourceARN !== 'string')
			return null;

		if(!(eventSourceARN in this.cache))
			this.cache[eventSourceARN] = this.parseArn(eventSourceARN);

		return this.cache[eventSourceARN];
	}

	/**
	 * @param {string} eventSourceARN
	 * @return {QueueData|null}
	 */
	static parseArn(eventSourceARN) {

		const [arnPrefix, , service, region, accountId, queueName] = eventSourceARN.split(':');

		if(arnPrefix !== 'arn' || service !== 'sqs' || !region || !accountId || !queueName)
			return null;

		return {
			queueUrl: `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`,
			region,
			fifo: queueName.endsWith('.fifo')
		};
	}

	/**
	 * Clears the parsed ARNs. Meant for tests.
	 */
	static resetCache() {
		this.cache = {};
	}
};
