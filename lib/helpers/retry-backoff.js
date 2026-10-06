'use strict';

const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');
const { captureAWSv3Client } = require('aws-xray-sdk-core');

const DEFAULT_BASE_DELAY_SECONDS = 60;

const DEFAULT_MAX_DELAY_SECONDS = 900;

const DEFAULT_JITTER_RATIO = 0.2;

/**
 * Max visibility timeout accepted by SQS (12 hours).
 */
const SQS_MAX_VISIBILITY_SECONDS = 43200;

/**
 * Max entries accepted by ChangeMessageVisibilityBatch.
 */
const VISIBILITY_BATCH_SIZE = 10;

const INVALID_QUEUE_ERROR_CODE = 'InvalidEventSourceARN';

const RECORD_NOT_FOUND_ERROR_CODE = 'RecordNotFound';

const ACCESS_DENIED_CODES = ['AccessDenied', 'AccessDeniedException'];

/**
 * @typedef {object} RetryBackoffConfig
 * @property {number} baseDelaySeconds
 * @property {number} maxDelaySeconds
 * @property {number} jitterRatio
 */

/**
 * @typedef {object} NormalizedConfig
 * @property {boolean} valid
 * @property {RetryBackoffConfig} [config] Present when valid
 * @property {string} [reason] Present when invalid
 */

/**
 * @typedef {object} FailedMessage
 * @property {string} messageId
 * @property {number} [minDelaySeconds]
 */

/**
 * @typedef {object} VisibilityFailure
 * @property {string} messageId
 * @property {string} errorCode The SQS error code of the entry, or the error name when the whole call failed
 * @property {string} [errorMessage]
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
 * @property {boolean} accessDenied Some call or entry was denied: the caller should disable the backoff
 * @property {boolean} fifo Some message belongs to a FIFO queue and was skipped
 * @property {Array<VisibilityFailure>} failures
 * @property {BackoffSummary} summary
 */

const clients = {};

function getClient(region) {

	clients[region] ??= captureAWSv3Client(new SQSClient({ region }));

	return clients[region];
}

/**
 * Clears the cached SQS clients. Meant for tests.
 */
function resetClients() {
	Object.keys(clients).forEach(region => delete clients[region]);
}

const isValidNumber = value => typeof value === 'number' && Number.isFinite(value);

/**
 * Applies defaults to the missing fields and validates the config. Never throws.
 *
 * @param {object} [config] The value returned by the `retryBackoff` getter
 * @return {NormalizedConfig}
 */
function normalizeConfig(config) {

	if(config !== undefined && config !== null && (typeof config !== 'object' || Array.isArray(config)))
		return { valid: false, reason: 'retryBackoff must be an object' };

	const {
		baseDelaySeconds = DEFAULT_BASE_DELAY_SECONDS,
		maxDelaySeconds = DEFAULT_MAX_DELAY_SECONDS,
		jitterRatio = DEFAULT_JITTER_RATIO
	} = config || {};

	const invalidNumber = Object.entries({ baseDelaySeconds, maxDelaySeconds, jitterRatio })
		.find(([, value]) => !isValidNumber(value));

	if(invalidNumber)
		return { valid: false, reason: `${invalidNumber[0]} must be a finite number` };

	if(baseDelaySeconds <= 0)
		return { valid: false, reason: 'baseDelaySeconds must be greater than 0' };

	if(baseDelaySeconds > maxDelaySeconds)
		return { valid: false, reason: 'baseDelaySeconds must not be greater than maxDelaySeconds' };

	if(maxDelaySeconds > SQS_MAX_VISIBILITY_SECONDS)
		return { valid: false, reason: `maxDelaySeconds must not be greater than ${SQS_MAX_VISIBILITY_SECONDS}` };

	if(jitterRatio < 0 || jitterRatio >= 1)
		return { valid: false, reason: 'jitterRatio must be in the range [0, 1)' };

	return { valid: true, config: { baseDelaySeconds, maxDelaySeconds, jitterRatio } };
}

/**
 * Gets the attempt of a SQS record: its `ApproximateReceiveCount`. Missing or invalid counts are the first attempt.
 *
 * @param {object} record The SQS record
 * @return {number} The attempt, 1-based
 */
function getAttempt(record) {

	const attempt = Number.parseInt(record?.attributes?.ApproximateReceiveCount, 10);

	return Number.isInteger(attempt) && attempt > 0 ? attempt : 1;
}

/**
 * Calculates the delay of a retry: `base × 2^(attempt − 1)`, with a ±`jitterRatio` jitter, floored by `minDelaySeconds`
 * and capped by `maxDelaySeconds` after both.
 *
 * @param {number} attempt The attempt that failed, 1-based. Invalid values are the first attempt.
 * @param {RetryBackoffConfig} config A valid normalized config
 * @param {number} [minDelaySeconds] Minimum delay
 * @return {number} The delay in seconds, integer
 */
function getRetryDelaySeconds(attempt, { baseDelaySeconds, maxDelaySeconds, jitterRatio }, minDelaySeconds) {

	const safeAttempt = Number.isInteger(attempt) && attempt > 0 ? attempt : 1;

	// For huge attempts 2 ** n is Infinity, and the final cap leaves it in maxDelaySeconds
	const delaySeconds = baseDelaySeconds * (2 ** (safeAttempt - 1));

	const jitterFactor = 1 + (((Math.random() * 2) - 1) * jitterRatio);

	const jitteredDelay = Math.round(delaySeconds * jitterFactor);

	const safeMinDelay = isValidNumber(minDelaySeconds) ? minDelaySeconds : 0;

	return Math.min(maxDelaySeconds, Math.ceil(Math.max(safeMinDelay, jitteredDelay)));
}

/**
 * Parses a SQS queue ARN (`arn:aws:sqs:<region>:<accountId>:<queueName>`).
 *
 * @param {string} eventSourceARN
 * @return {{queueUrl: string, region: string, fifo: boolean}|null} null when the ARN is not a SQS queue ARN
 */
function parseQueueArn(eventSourceARN) {

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

const isAccessDenied = error => ACCESS_DENIED_CODES.some(code => [error?.name, error?.Code, error?.code].includes(code));

/**
 * The entry `Id` is the index of the change in the chunk: unique and valid for SQS.
 *
 * @param {object} chunk
 * @return {Promise<{failures: Array<VisibilityFailure>, accessDenied: boolean}>}
 */
async function changeChunkVisibility({ queueUrl, region, changes }) {

	try {

		const { Failed = [] } = await getClient(region).send(new ChangeMessageVisibilityBatchCommand({
			QueueUrl: queueUrl,
			Entries: changes.map(({ receiptHandle, delaySeconds }, index) => ({
				Id: String(index),
				ReceiptHandle: receiptHandle,
				VisibilityTimeout: delaySeconds
			}))
		}));

		return {
			accessDenied: Failed.some(isAccessDenied),
			failures: Failed.map(({ Id, Code, Message }) => ({
				messageId: changes[Number(Id)]?.messageId,
				errorCode: Code,
				...Message && { errorMessage: Message }
			}))
		};

	} catch(error) {

		return {
			accessDenied: isAccessDenied(error),
			failures: changes.map(({ messageId }) => ({
				messageId,
				errorCode: error.name || error.Code || error.code,
				errorMessage: error.message
			}))
		};
	}
}

function buildChunks(changes) {

	const changesByQueue = {};

	changes.forEach(change => {
		changesByQueue[change.queueUrl] ??= { queueUrl: change.queueUrl, region: change.region, changes: [] };
		changesByQueue[change.queueUrl].changes.push(change);
	});

	return Object.values(changesByQueue).flatMap(({ queueUrl, region, changes: queueChanges }) => {

		const chunks = [];

		for(let chunkStart = 0; chunkStart < queueChanges.length; chunkStart += VISIBILITY_BATCH_SIZE)
			chunks.push({ queueUrl, region, changes: queueChanges.slice(chunkStart, chunkStart + VISIBILITY_BATCH_SIZE) });

		return chunks;
	});
}

const getRange = values => (values.length ? [Math.min(...values), Math.max(...values)] : [null, null]);

/**
 * Applies the backoff to the failed messages with ChangeMessageVisibilityBatch, in chunks of 10 messages of the same queue.
 * Never throws: every message whose visibility could not be changed is returned as a failure.
 * Messages of FIFO queues are skipped. Repeated `messageId`s are merged: the last `minDelaySeconds` wins.
 *
 * @param {Array<object>} records The `event.Records` of the invocation
 * @param {Array<FailedMessage>} failedMessages
 * @param {RetryBackoffConfig} config A valid normalized config (see `normalizeConfig()`)
 * @return {Promise<BackoffResult>}
 */
async function applyRetryBackoff(records, failedMessages, config) {

	const recordsByMessageId = new Map((records || []).map(record => [record.messageId, record]));

	const minDelayByMessageId = new Map(failedMessages.map(({ messageId, minDelaySeconds }) => [messageId, minDelaySeconds]));

	const failures = [];
	const changes = [];
	let fifo = false;

	minDelayByMessageId.forEach((minDelaySeconds, messageId) => {

		const record = recordsByMessageId.get(messageId);

		if(!record)
			return failures.push({ messageId, errorCode: RECORD_NOT_FOUND_ERROR_CODE });

		const queue = parseQueueArn(record.eventSourceARN);

		if(!queue)
			return failures.push({ messageId, errorCode: INVALID_QUEUE_ERROR_CODE });

		if(queue.fifo) {
			fifo = true;
			return;
		}

		const attempt = getAttempt(record);

		changes.push({
			messageId,
			receiptHandle: record.receiptHandle,
			queueUrl: queue.queueUrl,
			region: queue.region,
			attempt,
			delaySeconds: getRetryDelaySeconds(attempt, config, minDelaySeconds)
		});
	});

	const chunkResults = await Promise.all(buildChunks(changes).map(changeChunkVisibility));

	failures.push(...chunkResults.flatMap(result => result.failures));

	const [minAttempt, maxAttempt] = getRange(changes.map(({ attempt }) => attempt));
	const [minDelay, maxDelay] = getRange(changes.map(({ delaySeconds }) => delaySeconds));

	return {
		accessDenied: chunkResults.some(result => result.accessDenied),
		fifo,
		failures,
		summary: {
			applied: changes.length,
			failures: failures.length,
			minAttempt,
			maxAttempt,
			minDelay,
			maxDelay
		}
	};
}

module.exports = {
	DEFAULT_BASE_DELAY_SECONDS,
	DEFAULT_MAX_DELAY_SECONDS,
	DEFAULT_JITTER_RATIO,
	VISIBILITY_BATCH_SIZE,
	normalizeConfig,
	getAttempt,
	getRetryDelaySeconds,
	parseQueueArn,
	applyRetryBackoff,
	resetClients
};
