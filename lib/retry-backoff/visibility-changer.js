'use strict';

const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');
const { captureAWSv3Client } = require('aws-xray-sdk-core');

/**
 * @typedef {object} VisibilityChange
 * @property {string} messageId
 * @property {string} receiptHandle
 * @property {string} queueUrl
 * @property {string} region
 * @property {number} attempt
 * @property {number} delaySeconds
 */

/**
 * @typedef {object} VisibilityFailure
 * @property {string} messageId
 * @property {string} errorCode The SQS error code of the entry, or the error name when the whole call failed
 * @property {string} [errorMessage]
 */

/**
 * @typedef {object} VisibilityResult
 * @property {boolean} accessDenied Some call or entry was denied
 * @property {Array<VisibilityFailure>} failures
 */

/**
 * @typedef {object} VisibilityChunk
 * @property {string} queueUrl
 * @property {string} region
 * @property {Array<VisibilityChange>} changes
 */

/**
 * @typedef {object} QueueData
 * @property {string} queueUrl
 * @property {string} region
 * @property {boolean} fifo
 */

module.exports = class VisibilityChanger {

	/**
	 * Max entries accepted by ChangeMessageVisibilityBatch.
	 *
	 * @return {number}
	 */
	static get batchSize() {
		return 10;
	}

	static get accessDeniedCodes() {
		return ['AccessDenied', 'AccessDeniedException'];
	}

	/**
	 * SQS clients by region. They live as long as the container.
	 *
	 * @type {Object<string, SQSClient>}
	 */
	static clients = {};

	/**
	 * Parses a SQS queue ARN (`arn:aws:sqs:<region>:<accountId>:<queueName>`).
	 *
	 * @param {string} eventSourceARN
	 * @return {QueueData|null} null when the ARN is not a SQS queue ARN
	 */
	static parseQueueArn(eventSourceARN) {

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

	/**
	 * Changes the visibility with ChangeMessageVisibilityBatch, in parallel chunks of 10 messages of the same queue.
	 * Never throws: every message whose visibility could not be changed is returned as a failure.
	 *
	 * @param {Array<VisibilityChange>} changes
	 * @return {Promise<VisibilityResult>}
	 */
	static async change(changes) {

		const chunkResults = await Promise.all(this.buildChunks(changes).map(chunk => this.changeChunk(chunk)));

		return {
			accessDenied: chunkResults.some(({ accessDenied }) => accessDenied),
			failures: chunkResults.flatMap(({ failures }) => failures)
		};
	}

	/**
	 * @param {Array<VisibilityChange>} changes
	 * @return {Array<VisibilityChunk>}
	 */
	static buildChunks(changes) {

		const changesByQueue = {};

		changes.forEach(change => {
			changesByQueue[change.queueUrl] ??= { queueUrl: change.queueUrl, region: change.region, changes: [] };
			changesByQueue[change.queueUrl].changes.push(change);
		});

		return Object.values(changesByQueue).flatMap(queueChanges => this.splitQueueChanges(queueChanges));
	}

	/**
	 * @param {VisibilityChunk} queueChanges Every change of a queue
	 * @return {Array<VisibilityChunk>} Chunks of `batchSize` changes
	 */
	static splitQueueChanges({ queueUrl, region, changes }) {

		const chunks = [];

		for(let chunkStart = 0; chunkStart < changes.length; chunkStart += this.batchSize)
			chunks.push({ queueUrl, region, changes: changes.slice(chunkStart, chunkStart + this.batchSize) });

		return chunks;
	}

	/**
	 * @param {VisibilityChunk} chunk
	 * @return {Promise<VisibilityResult>}
	 */
	static async changeChunk({ queueUrl, region, changes }) {

		try {

			const { Failed = [] } = await this.getClient(region).send(new ChangeMessageVisibilityBatchCommand({
				QueueUrl: queueUrl,
				Entries: this.buildEntries(changes)
			}));

			return {
				accessDenied: Failed.some(failedEntry => this.isAccessDenied(failedEntry)),
				failures: Failed.map(failedEntry => this.formatEntryFailure(failedEntry, changes))
			};

		} catch(error) {

			return {
				accessDenied: this.isAccessDenied(error),
				failures: changes.map(({ messageId }) => ({
					messageId,
					errorCode: error.name || error.Code || error.code,
					errorMessage: error.message
				}))
			};
		}
	}

	/**
	 * @param {string} region
	 * @return {SQSClient}
	 */
	static getClient(region) {

		this.clients[region] ??= captureAWSv3Client(new SQSClient({ region }));

		return this.clients[region];
	}

	/**
	 * The entry `Id` is the index of the change in the chunk: unique and valid for SQS.
	 *
	 * @param {Array<VisibilityChange>} changes
	 * @return {Array<object>}
	 */
	static buildEntries(changes) {
		return changes.map(({ receiptHandle, delaySeconds }, index) => ({
			Id: String(index),
			ReceiptHandle: receiptHandle,
			VisibilityTimeout: delaySeconds
		}));
	}

	/**
	 * @param {{Id: string, Code: string, Message?: string}} failedEntry
	 * @param {Array<VisibilityChange>} changes The changes of the chunk
	 * @return {VisibilityFailure}
	 */
	static formatEntryFailure({ Id, Code, Message }, changes) {
		return {
			messageId: changes[Number(Id)]?.messageId,
			errorCode: Code,
			...Message && { errorMessage: Message }
		};
	}

	/**
	 * @param {object} error A thrown error or a failed entry
	 * @return {boolean}
	 */
	static isAccessDenied(error) {
		return this.accessDeniedCodes.some(code => [error?.name, error?.Code, error?.code].includes(code));
	}

	/**
	 * Clears the cached SQS clients. Meant for tests.
	 */
	static resetClients() {
		this.clients = {};
	}
};
