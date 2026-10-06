'use strict';

/**
 * @typedef {object} QueueData
 * @property {string} queueUrl
 * @property {string} region
 * @property {boolean} fifo
 */

module.exports = class QueueArn {

	/**
	 * Parses a SQS queue ARN (`arn:aws:sqs:<region>:<accountId>:<queueName>`).
	 *
	 * @param {string} eventSourceARN
	 * @return {QueueData|null} null when the ARN is not a SQS queue ARN
	 */
	static parse(eventSourceARN) {

		if(typeof eventSourceARN !== 'string')
			return null;

		const [arnPrefix, , service, region, accountId, queueName] = eventSourceARN.split(':');

		if(arnPrefix !== 'arn' || service !== 'sqs' || !region || !accountId || !queueName)
			return null;

		return {
			queueUrl: `https://sqs.${region}.amazonaws.com/${accountId}/${queueName}`,
			region,
			fifo: queueName.endsWith('.fifo')
		};
	}
};
