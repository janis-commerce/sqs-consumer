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
 * @typedef {object} VisibilityChunk Up to `batchSize` changes of the same queue, ready to send
 * @property {string} queueUrl
 * @property {string} region
 * @property {Array<{Id: string, ReceiptHandle: string, VisibilityTimeout: number}>} entries
 * @property {Array<string>} messageIds The messageId of each entry, by position: the entry `Id` is its index
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

	/**
	 * Max ChangeMessageVisibilityBatch calls in flight at the same time.
	 *
	 * @return {number}
	 */
	static get concurrency() {
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
	 * Changes the visibility with ChangeMessageVisibilityBatch, in chunks of 10 messages of the same queue.
	 * Sends the chunks in waves of `concurrency` calls. After a wave with an AccessDenied, the remaining chunks are not sent.
	 * Never throws: every message whose visibility could not be changed is returned as a failure.
	 *
	 * @param {Array<VisibilityChange>} changes
	 * @return {Promise<VisibilityResult>}
	 */
	static async change(changes) {

		const chunks = this.buildChunks(changes);

		const result = { accessDenied: false, failures: [] };

		for(let waveStart = 0; waveStart < chunks.length; waveStart += this.concurrency) {

			if(result.accessDenied) {
				result.failures.push(...this.buildNotSentFailures(chunks.slice(waveStart)));
				break;
			}

			const wave = chunks.slice(waveStart, waveStart + this.concurrency);

			// Waves are serial on purpose: they limit the concurrency and allow to stop after an AccessDenied
			// eslint-disable-next-line no-await-in-loop
			await Promise.all(wave.map(async chunk => {

				const { accessDenied, failures } = await this.changeChunk(chunk);

				result.accessDenied ||= accessDenied;
				result.failures.push(...failures);
			}));
		}

		return result;
	}

	/**
	 * Groups the changes by queue in chunks of `batchSize`, building the entries of each chunk in the same pass.
	 *
	 * @param {Array<VisibilityChange>} changes
	 * @return {Array<VisibilityChunk>}
	 */
	static buildChunks(changes) {

		const chunks = [];
		const openChunksByQueue = {};

		changes.forEach(({
			messageId, receiptHandle, queueUrl, region, delaySeconds
		}) => {

			const openChunk = openChunksByQueue[queueUrl];

			if(!openChunk || openChunk.entries.length === this.batchSize) {
				openChunksByQueue[queueUrl] = { queueUrl, region, entries: [], messageIds: [] };
				chunks.push(openChunksByQueue[queueUrl]);
			}

			const chunk = openChunksByQueue[queueUrl];

			chunk.entries.push({ Id: String(chunk.entries.length), ReceiptHandle: receiptHandle, VisibilityTimeout: delaySeconds });
			chunk.messageIds.push(messageId);
		});

		return chunks;
	}

	/**
	 * @param {VisibilityChunk} chunk
	 * @return {Promise<VisibilityResult>}
	 */
	static async changeChunk({
		queueUrl, region, entries, messageIds
	}) {

		try {

			const { Failed = [] } = await this.getClient(region).send(new ChangeMessageVisibilityBatchCommand({
				QueueUrl: queueUrl,
				Entries: entries
			}));

			return {
				accessDenied: Failed.some(failedEntry => this.isAccessDenied(failedEntry)),
				failures: Failed.map(failedEntry => this.formatEntryFailure(failedEntry, messageIds))
			};

		} catch(error) {

			return {
				accessDenied: this.isAccessDenied(error),
				failures: messageIds.map(messageId => ({
					messageId,
					errorCode: error.name || error.Code || error.code,
					errorMessage: error.message
				}))
			};
		}
	}

	/**
	 * The messages of the chunks not sent after an AccessDenied fail with AccessDenied too.
	 *
	 * @param {Array<VisibilityChunk>} notSentChunks
	 * @return {Array<VisibilityFailure>}
	 */
	static buildNotSentFailures(notSentChunks) {
		return notSentChunks.flatMap(({ messageIds }) => messageIds.map(messageId => ({
			messageId,
			errorCode: this.accessDeniedCodes[0],
			errorMessage: 'Not sent: a previous call was denied'
		})));
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
	 * @param {{Id: string, Code: string, Message?: string}} failedEntry
	 * @param {Array<string>} messageIds The messageIds of the chunk
	 * @return {VisibilityFailure}
	 */
	static formatEntryFailure({ Id, Code, Message }, messageIds) {
		return {
			messageId: messageIds[Number(Id)],
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
