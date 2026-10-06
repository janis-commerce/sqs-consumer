'use strict';

const assert = require('assert');
const sinon = require('sinon');
const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');

const RetryBackoff = require('../../lib/retry-backoff');
const VisibilityChanger = require('../../lib/retry-backoff/visibility-changer');
const { RetryBackoff: ExportedRetryBackoff } = require('../../lib');

describe('RetryBackoff', () => {

	const config = { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2 };

	const noJitterConfig = { ...config, jitterRatio: 0 };

	const queueArn = 'arn:aws:sqs:us-east-1:123456789012:MyQueue';

	const fifoQueueArn = 'arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo';

	const buildRecord = (id, extra = {}) => ({
		messageId: `msg-${id}`,
		receiptHandle: `handle-${id}`,
		eventSourceARN: queueArn,
		attributes: { ApproximateReceiveCount: '1' },
		...extra
	});

	const toFailedMessages = records => records.map(({ messageId }) => ({ messageId }));

	let sqsMock;

	const getCalls = () => sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand);

	const getEntries = (call = 0) => getCalls()[call].args[0].input;

	beforeEach(() => {
		sqsMock = mockClient(SQSClient);
		sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Successful: [], Failed: [] });
		VisibilityChanger.resetClients();
		RetryBackoff.resetState();
	});

	afterEach(() => {
		sqsMock.restore();
		sinon.restore();
		RetryBackoff.resetState();
	});

	it('Should be exported from the package index', () => {

		assert.strictEqual(ExportedRetryBackoff, RetryBackoff);
		assert.strictEqual(typeof ExportedRetryBackoff.getAttempt, 'function');
		assert.strictEqual(typeof ExportedRetryBackoff.getRetryDelaySeconds, 'function');
	});

	describe('getAttempt', () => {

		it('Should return the ApproximateReceiveCount as number', () => {
			assert.strictEqual(RetryBackoff.getAttempt({ attributes: { ApproximateReceiveCount: '3' } }), 3);
		});

		it('Should return 1 for an invalid record', () => {
			assert.strictEqual(RetryBackoff.getAttempt(undefined), 1);
		});
	});

	describe('getRetryDelaySeconds', () => {

		it('Should complete the missing fields of the config with the defaults', () => {

			assert.deepStrictEqual([1, 2, 3].map(attempt => RetryBackoff.getRetryDelaySeconds(attempt, { jitterRatio: 0 })), [60, 120, 240]);
			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(1, { baseDelaySeconds: 300, jitterRatio: 0 }), 300);
		});

		[undefined, null, false, true, {}].forEach(input => {

			it(`Should use the defaults when the config is ${JSON.stringify(input)}`, () => {

				sinon.stub(Math, 'random').returns(0);
				assert.strictEqual(RetryBackoff.getRetryDelaySeconds(2, input), 120);
			});
		});

		it('Should apply minDelaySeconds', () => {

			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(1, { jitterRatio: 0 }, 200), 200);
		});

		it('Should apply the base delay as floor and the jitter upwards', () => {

			sinon.stub(Math, 'random').returns(0.999);
			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(1, undefined, 10), 72);

			Math.random.returns(0);
			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(1, undefined, 10), 60);
		});

		it('Should cap at maxDelaySeconds without the cap of the invocation', () => {

			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(1, { maxDelaySeconds: 43200, jitterRatio: 0 }, 43200), 43200);
		});

		it('Should throw an Error with the reason when the config is invalid', () => {

			assert.throws(
				() => RetryBackoff.getRetryDelaySeconds(1, { baseDelaySeconds: 0 }),
				{ message: 'Invalid retryBackoff config: baseDelaySeconds must be greater than 0' }
			);
			assert.throws(
				() => RetryBackoff.getRetryDelaySeconds(1, { maxDelaySeconds: 43201 }),
				{ message: /maxDelaySeconds must not be greater than 43200/ }
			);
			assert.throws(() => RetryBackoff.getRetryDelaySeconds(1, 'foo'), { message: /retryBackoff must be an object/ });
		});

		it('Should return the same delay the handler applies, with the same Math.random', async () => {

			sinon.stub(Math, 'random').returns(0.3);

			const records = [buildRecord(1, { attributes: { ApproximateReceiveCount: '3' } })];

			await RetryBackoff.apply({ retryBackoff: { baseDelaySeconds: 300 } }, records, [{ messageId: 'msg-1' }]);

			const [{ VisibilityTimeout }] = getEntries().Entries;

			assert.strictEqual(RetryBackoff.getRetryDelaySeconds(RetryBackoff.getAttempt(records[0]), { baseDelaySeconds: 300 }), VisibilityTimeout);
		});
	});

	describe('delayRetries', () => {

		it('Should change the visibility of the failed messages only', async () => {

			const records = [buildRecord(1, { attributes: { ApproximateReceiveCount: '2' } }), buildRecord(2)];

			const result = await RetryBackoff.delayRetries(records, [{ messageId: 'msg-1' }], noJitterConfig);

			sinon.assert.match(getEntries(), {
				QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
				Entries: [{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 120 }]
			});

			assert.strictEqual(getCalls().length, 1);

			assert.deepStrictEqual(result, {
				accessDenied: false,
				fifo: false,
				failures: [],
				summary: {
					applied: 1, failures: 0, minAttempt: 2, maxAttempt: 2, minDelay: 120, maxDelay: 120
				}
			});
		});

		it('Should use the default attempt and the minDelaySeconds of each failed message', async () => {

			const records = [buildRecord(1, { attributes: {} }), buildRecord(2)];

			await RetryBackoff.delayRetries(records, [{ messageId: 'msg-1' }, { messageId: 'msg-2', minDelaySeconds: 300 }], noJitterConfig);

			assert.deepStrictEqual(getEntries().Entries.map(entry => entry.VisibilityTimeout), [60, 300]);
		});

		it('Should merge repeated messageIds, last minDelaySeconds wins', async () => {

			const result = await RetryBackoff.delayRetries([buildRecord(1)], [
				{ messageId: 'msg-1', minDelaySeconds: 100 },
				{ messageId: 'msg-1', minDelaySeconds: 200 }
			], noJitterConfig);

			assert.deepStrictEqual(getEntries().Entries, [{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 200 }]);
			assert.strictEqual(result.summary.applied, 1);
		});

		it('Should use the exact delaySeconds of the last call of a repeated message', async () => {

			await RetryBackoff.delayRetries([buildRecord(1)], [
				{ messageId: 'msg-1', minDelaySeconds: 100, delaySeconds: 50 },
				{ messageId: 'msg-1', delaySeconds: 5000 }
			], config);

			assert.deepStrictEqual(getEntries().Entries, [{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 900 }]);
		});

		it('Should not call SQS when there are no failed messages', async () => {

			const result = await RetryBackoff.delayRetries([buildRecord(1)], [], config);

			assert.strictEqual(getCalls().length, 0);

			assert.deepStrictEqual(result.summary, {
				applied: 0, failures: 0, minAttempt: null, maxAttempt: null, minDelay: null, maxDelay: null
			});
		});

		it('Should report the summary ranges', async () => {

			const records = [
				buildRecord(1, { attributes: { ApproximateReceiveCount: '1' } }),
				buildRecord(2, { attributes: { ApproximateReceiveCount: '3' } })
			];

			const result = await RetryBackoff.delayRetries(records, toFailedMessages(records), noJitterConfig);

			assert.deepStrictEqual(result.summary, {
				applied: 2, failures: 0, minAttempt: 1, maxAttempt: 3, minDelay: 60, maxDelay: 240
			});
		});

		it('Should return the SQS failures and the accessDenied flag', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Failed: [{ Id: '0', Code: 'AccessDenied' }] });

			const records = [buildRecord(1), buildRecord(2)];

			const result = await RetryBackoff.delayRetries(records, toFailedMessages(records), noJitterConfig);

			assert.strictEqual(result.accessDenied, true);
			assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: 'AccessDenied' }]);
			assert.strictEqual(result.summary.failures, 1);
		});

		it('Should fail the messages without a record and without calling SQS for them', async () => {

			const result = await RetryBackoff.delayRetries([buildRecord(1)], [{ messageId: 'unknown' }], noJitterConfig);

			assert.strictEqual(getCalls().length, 0);
			assert.deepStrictEqual(result.failures, [{ messageId: 'unknown', errorCode: 'RecordNotFound' }]);
			assert.strictEqual(result.summary.failures, 1);
		});

		it('Should fail the messages without records at all', async () => {

			const result = await RetryBackoff.delayRetries(undefined, [{ messageId: 'msg-1' }], noJitterConfig);

			assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: 'RecordNotFound' }]);
		});

		it('Should fail the messages with an invalid eventSourceARN without calling SQS', async () => {

			const result = await RetryBackoff.delayRetries([buildRecord(1, { eventSourceARN: 'foo' })], [{ messageId: 'msg-1' }], noJitterConfig);

			assert.strictEqual(getCalls().length, 0);
			assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: 'InvalidEventSourceARN' }]);
		});

		it('Should skip FIFO queues and flag them', async () => {

			const records = [buildRecord(1, { eventSourceARN: fifoQueueArn }), buildRecord(2)];

			const result = await RetryBackoff.delayRetries(records, toFailedMessages(records), noJitterConfig);

			assert.strictEqual(result.fifo, true);
			assert.strictEqual(result.summary.applied, 1);
			assert.deepStrictEqual(getEntries().Entries.map(({ ReceiptHandle }) => ReceiptHandle), ['handle-2']);
		});

		it('Should not call SQS when every message is FIFO', async () => {

			const result = await RetryBackoff.delayRetries([buildRecord(1, { eventSourceARN: fifoQueueArn })], [{ messageId: 'msg-1' }], noJitterConfig);

			assert.strictEqual(getCalls().length, 0);
			assert.strictEqual(result.fifo, true);
			assert.deepStrictEqual(result.failures, []);
		});
	});

	describe('apply', () => {

		it('Should read the retryBackoff getter once per container until the state is reset', async () => {

			const getter = sinon.stub().returns(noJitterConfig);

			const consumerInstance = {
				get retryBackoff() {
					return getter();
				}
			};

			await RetryBackoff.apply(consumerInstance, [buildRecord(1)], [{ messageId: 'msg-1' }]);
			await RetryBackoff.apply(consumerInstance, [buildRecord(1)], [{ messageId: 'msg-1' }]);

			sinon.assert.calledOnce(getter);
			assert.strictEqual(getCalls().length, 2);

			RetryBackoff.resetState();

			await RetryBackoff.apply(consumerInstance, [buildRecord(1)], [{ messageId: 'msg-1' }]);

			sinon.assert.calledTwice(getter);
		});

		it('Should cap the delays with the time left of the invocation', async () => {

			const startedAt = 1700000000000;
			const longConfig = { baseDelaySeconds: 60, maxDelaySeconds: 43200, jitterRatio: 0 };
			const failedMessages = [{ messageId: 'msg-1', delaySeconds: 43200 }, { messageId: 'msg-2', delaySeconds: 1000 }];

			sinon.useFakeTimers(startedAt + 600000);

			await RetryBackoff.apply({ retryBackoff: longConfig }, [buildRecord(1), buildRecord(2)], failedMessages, startedAt);

			assert.deepStrictEqual(getEntries().Entries.map(({ VisibilityTimeout }) => VisibilityTimeout), [42270, 1000]);
		});

		it('Should take the start of the invocation from now when it is not received', async () => {

			sinon.useFakeTimers(1700000000000);

			await RetryBackoff.apply({ retryBackoff: { maxDelaySeconds: 43200 } }, [buildRecord(1)], [{ messageId: 'msg-1', delaySeconds: 43200 }]);

			assert.strictEqual(getEntries().Entries[0].VisibilityTimeout, 42870);
		});

		it('Should not call SQS if the backoff is disabled', async () => {

			sinon.spy(VisibilityChanger, 'change');

			await RetryBackoff.apply({}, [buildRecord(1)], [{ messageId: 'msg-1' }]);

			sinon.assert.notCalled(VisibilityChanger.change);
			assert.deepStrictEqual(RetryBackoff.state, { enabled: false, config: undefined, fifoWarned: false });
		});
	});
});
