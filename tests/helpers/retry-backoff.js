'use strict';

const assert = require('assert');
const sinon = require('sinon');
const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');

const {
	normalizeConfig,
	getAttempt,
	getRetryDelaySeconds,
	parseQueueArn,
	applyRetryBackoff,
	resetClients
} = require('../../lib/helpers/retry-backoff');

describe('Helpers', () => {

	describe('RetryBackoff', () => {

		const config = { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2 };

		const noJitterConfig = { ...config, jitterRatio: 0 };

		const queueArn = 'arn:aws:sqs:us-east-1:123456789012:MyQueue';

		const buildRecord = (id, extra = {}) => ({
			messageId: `msg-${id}`,
			receiptHandle: `handle-${id}`,
			eventSourceARN: queueArn,
			attributes: { ApproximateReceiveCount: '1' },
			...extra
		});

		let sqsMock;

		beforeEach(() => {
			sqsMock = mockClient(SQSClient);
			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Successful: [], Failed: [] });
			resetClients();
		});

		afterEach(() => {
			sqsMock.restore();
			sinon.restore();
		});

		describe('normalizeConfig', () => {

			it('Should apply the defaults when the config is empty, null or undefined', () => {

				[{}, null, undefined].forEach(input => {
					assert.deepStrictEqual(normalizeConfig(input), { valid: true, config });
				});
			});

			it('Should keep the provided values and default the missing ones', () => {

				assert.deepStrictEqual(normalizeConfig({ baseDelaySeconds: 10, jitterRatio: 0 }), {
					valid: true,
					config: { baseDelaySeconds: 10, maxDelaySeconds: 900, jitterRatio: 0 }
				});
			});

			it('Should accept the limits', () => {

				assert.strictEqual(normalizeConfig({ baseDelaySeconds: 43200, maxDelaySeconds: 43200, jitterRatio: 0.99 }).valid, true);
			});

			[
				['not an object', 'foo', 'retryBackoff must be an object'],
				['an array', [], 'retryBackoff must be an object'],
				['non numeric base', { baseDelaySeconds: '60' }, 'baseDelaySeconds must be a finite number'],
				['non finite max', { maxDelaySeconds: Infinity }, 'maxDelaySeconds must be a finite number'],
				['NaN jitter', { jitterRatio: NaN }, 'jitterRatio must be a finite number'],
				['zero base', { baseDelaySeconds: 0 }, 'baseDelaySeconds must be greater than 0'],
				['negative base', { baseDelaySeconds: -1 }, 'baseDelaySeconds must be greater than 0'],
				['base greater than max', { baseDelaySeconds: 1000 }, 'baseDelaySeconds must not be greater than maxDelaySeconds'],
				['max greater than 43200', { maxDelaySeconds: 43201 }, 'maxDelaySeconds must not be greater than 43200'],
				['negative jitter', { jitterRatio: -0.1 }, 'jitterRatio must be in the range [0, 1)'],
				['jitter of 1', { jitterRatio: 1 }, 'jitterRatio must be in the range [0, 1)']
			].forEach(([title, input, reason]) => {

				it(`Should return invalid with the reason when the config has ${title}`, () => {
					assert.deepStrictEqual(normalizeConfig(input), { valid: false, reason });
				});
			});
		});

		describe('getAttempt', () => {

			it('Should return the ApproximateReceiveCount as number', () => {
				assert.strictEqual(getAttempt({ attributes: { ApproximateReceiveCount: '3' } }), 3);
			});

			[undefined, null, {}, { attributes: {} }, { attributes: { ApproximateReceiveCount: 'foo' } },
				{ attributes: { ApproximateReceiveCount: '0' } }, { attributes: { ApproximateReceiveCount: '-2' } }
			].forEach(record => {

				it(`Should return 1 for ${JSON.stringify(record)}`, () => {
					assert.strictEqual(getAttempt(record), 1);
				});
			});
		});

		describe('getRetryDelaySeconds', () => {

			it('Should grow exponentially without jitter', () => {

				assert.deepStrictEqual([1, 2, 3, 4].map(attempt => getRetryDelaySeconds(attempt, noJitterConfig)), [60, 120, 240, 480]);
			});

			it('Should use the first attempt when the attempt is invalid', () => {

				assert.strictEqual(getRetryDelaySeconds(0, noJitterConfig), 60);
				assert.strictEqual(getRetryDelaySeconds('foo', noJitterConfig), 60);
			});

			it('Should apply the jitter in both directions', () => {

				sinon.stub(Math, 'random').returns(0);
				assert.strictEqual(getRetryDelaySeconds(1, config), 48);

				Math.random.returns(0.5);
				assert.strictEqual(getRetryDelaySeconds(1, config), 60);

				Math.random.returns(1);
				assert.strictEqual(getRetryDelaySeconds(1, config), 72);
			});

			it('Should round the result to an integer', () => {

				sinon.stub(Math, 'random').returns(0.123);
				assert.ok(Number.isInteger(getRetryDelaySeconds(1, { ...config, baseDelaySeconds: 7 })));
			});

			it('Should raise the delay up to minDelaySeconds', () => {

				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, 200), 200);
				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, 30), 60);
			});

			it('Should ignore an invalid minDelaySeconds', () => {

				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, 'foo'), 60);
				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, NaN), 60);
			});

			it('Should ceil a fractional minDelaySeconds', () => {

				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, 100.2), 101);
			});

			it('Should cap the delay at maxDelaySeconds, also the floor', () => {

				assert.strictEqual(getRetryDelaySeconds(10, noJitterConfig), 900);
				assert.strictEqual(getRetryDelaySeconds(1, noJitterConfig, 5000), 900);
			});

			it('Should cap at maxDelaySeconds after the jitter', () => {

				sinon.stub(Math, 'random').returns(1);
				assert.strictEqual(getRetryDelaySeconds(5, config), 900);
			});

			it('Should return maxDelaySeconds when 2 ** n overflows', () => {

				assert.strictEqual(getRetryDelaySeconds(5000, config), 900);
			});
		});

		describe('parseQueueArn', () => {

			it('Should return the queue url, the region and the fifo flag', () => {

				assert.deepStrictEqual(parseQueueArn(queueArn), {
					queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
					region: 'us-east-1',
					fifo: false
				});
			});

			it('Should detect FIFO queues', () => {

				assert.strictEqual(parseQueueArn('arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo').fifo, true);
			});

			[undefined, null, 123, '', 'foo', 'arn:aws:s3:us-east-1:123456789012:MyQueue', 'arn:aws:sqs:us-east-1:123456789012',
				'arn:aws:sqs::123456789012:MyQueue', 'arn:aws:sqs:us-east-1::MyQueue'
			].forEach(arn => {

				it(`Should return null for ${JSON.stringify(arn)}`, () => {
					assert.strictEqual(parseQueueArn(arn), null);
				});
			});
		});

		describe('applyRetryBackoff', () => {

			const getEntries = (call = 0) => sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand)[call].args[0].input;

			it('Should change the visibility of the failed messages only', async () => {

				const records = [buildRecord(1, { attributes: { ApproximateReceiveCount: '2' } }), buildRecord(2)];

				const result = await applyRetryBackoff(records, [{ messageId: 'msg-1' }], noJitterConfig);

				sinon.assert.match(getEntries(), {
					QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
					Entries: [{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 120 }]
				});

				assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 1);

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

				await applyRetryBackoff(records, [{ messageId: 'msg-1' }, { messageId: 'msg-2', minDelaySeconds: 300 }], noJitterConfig);

				assert.deepStrictEqual(getEntries().Entries.map(entry => entry.VisibilityTimeout), [60, 300]);
			});

			it('Should merge repeated messageIds, last minDelaySeconds wins', async () => {

				const result = await applyRetryBackoff([buildRecord(1)], [
					{ messageId: 'msg-1', minDelaySeconds: 100 },
					{ messageId: 'msg-1', minDelaySeconds: 200 }
				], noJitterConfig);

				assert.deepStrictEqual(getEntries().Entries, [{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 200 }]);
				assert.strictEqual(result.summary.applied, 1);
			});

			it('Should not call SQS when there are no failed messages', async () => {

				const result = await applyRetryBackoff([buildRecord(1)], [], config);

				assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 0);

				assert.deepStrictEqual(result.summary, {
					applied: 0, failures: 0, minAttempt: null, maxAttempt: null, minDelay: null, maxDelay: null
				});
			});

			it('Should report the summary ranges', async () => {

				const records = [
					buildRecord(1, { attributes: { ApproximateReceiveCount: '1' } }),
					buildRecord(2, { attributes: { ApproximateReceiveCount: '3' } })
				];

				const result = await applyRetryBackoff(records, [{ messageId: 'msg-1' }, { messageId: 'msg-2' }], noJitterConfig);

				assert.deepStrictEqual(result.summary, {
					applied: 2, failures: 0, minAttempt: 1, maxAttempt: 3, minDelay: 60, maxDelay: 240
				});
			});

			it('Should chunk the messages of a queue by 10, in parallel', async () => {

				const records = Array.from({ length: 25 }, (_, index) => buildRecord(index));

				await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				const calls = sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand);

				assert.deepStrictEqual(calls.map(call => call.args[0].input.Entries.length), [10, 10, 5]);
				assert.deepStrictEqual(calls[2].args[0].input.Entries.map(({ Id }) => Id), ['0', '1', '2', '3', '4']);
			});

			it('Should make one call per queue and a client per region', async () => {

				const records = [
					buildRecord(1),
					buildRecord(2, { eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:OtherQueue' }),
					buildRecord(3, { eventSourceARN: 'arn:aws:sqs:us-west-2:123456789012:MyQueue' }),
					buildRecord(4)
				];

				await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				const calls = sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand);

				assert.deepStrictEqual(calls.map(call => call.args[0].input.QueueUrl), [
					'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
					'https://sqs.us-east-1.amazonaws.com/123456789012/OtherQueue',
					'https://sqs.us-west-2.amazonaws.com/123456789012/MyQueue'
				]);
				assert.deepStrictEqual(calls.map(call => call.args[0].input.Entries.length), [2, 1, 1]);
			});

			it('Should reuse the cached client of a region', async () => {

				const records = Array.from({ length: 11 }, (_, index) => buildRecord(index));

				await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				assert.strictEqual(sqsMock.calls().length, 2);
				assert.strictEqual(sqsMock.calls()[0].thisValue, sqsMock.calls()[1].thisValue);
			});

			it('Should return the failures of a partial failure by messageId', async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({
					Failed: [
						{ Id: '1', Code: 'ReceiptHandleIsInvalid', Message: 'Invalid handle', SenderFault: true },
						{ Id: '0', Code: 'InternalError' }
					]
				});

				const records = [buildRecord(1), buildRecord(2)];

				const result = await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				assert.deepStrictEqual(result.failures, [
					{ messageId: 'msg-2', errorCode: 'ReceiptHandleIsInvalid', errorMessage: 'Invalid handle' },
					{ messageId: 'msg-1', errorCode: 'InternalError' }
				]);
				assert.strictEqual(result.accessDenied, false);
				assert.strictEqual(result.summary.failures, 2);
			});

			it('Should handle a response without Failed', async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({});

				const result = await applyRetryBackoff([buildRecord(1)], [{ messageId: 'msg-1' }], noJitterConfig);

				assert.deepStrictEqual(result.failures, []);
			});

			it('Should return every message of the chunk as failed when the call throws, and never throw', async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));

				const records = [buildRecord(1), buildRecord(2)];

				const result = await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				assert.deepStrictEqual(result.failures, [
					{ messageId: 'msg-1', errorCode: 'ServiceUnavailable', errorMessage: 'boom' },
					{ messageId: 'msg-2', errorCode: 'ServiceUnavailable', errorMessage: 'boom' }
				]);
				assert.strictEqual(result.accessDenied, false);
			});

			it('Should use the error Code or code when the error has no name', async () => {

				const withCode = new Error('boom');
				withCode.name = '';
				withCode.Code = 'SomeCode';

				const withLowerCode = new Error('boom');
				withLowerCode.name = '';
				withLowerCode.code = 'some_code';

				sqsMock.on(ChangeMessageVisibilityBatchCommand).rejectsOnce(withCode)
					.rejectsOnce(withLowerCode);

				const records = Array.from({ length: 11 }, (_, index) => buildRecord(index));

				const result = await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				assert.deepStrictEqual([...new Set(result.failures.map(({ errorCode }) => errorCode))].sort(), ['SomeCode', 'some_code']);
			});

			['AccessDenied', 'AccessDeniedException'].forEach(code => {

				it(`Should flag accessDenied when the call throws ${code} as name`, async () => {

					sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('denied'), { name: code }));

					const result = await applyRetryBackoff([buildRecord(1)], [{ messageId: 'msg-1' }], noJitterConfig);

					assert.strictEqual(result.accessDenied, true);
					assert.strictEqual(result.failures.length, 1);
				});

				it(`Should flag accessDenied when the call throws ${code} as Code`, async () => {

					sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('denied'), { name: 'Error', Code: code }));

					const result = await applyRetryBackoff([buildRecord(1)], [{ messageId: 'msg-1' }], noJitterConfig);

					assert.strictEqual(result.accessDenied, true);
				});

				it(`Should flag accessDenied when an entry fails with ${code}`, async () => {

					sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Failed: [{ Id: '0', Code: code }] });

					const result = await applyRetryBackoff([buildRecord(1)], [{ messageId: 'msg-1' }], noJitterConfig);

					assert.strictEqual(result.accessDenied, true);
					assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: code }]);
				});
			});

			it('Should fail the messages without a record and without calling SQS for them', async () => {

				const result = await applyRetryBackoff([buildRecord(1)], [{ messageId: 'unknown' }], noJitterConfig);

				assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 0);
				assert.deepStrictEqual(result.failures, [{ messageId: 'unknown', errorCode: 'RecordNotFound' }]);
				assert.strictEqual(result.summary.failures, 1);
			});

			it('Should fail the messages without records at all', async () => {

				const result = await applyRetryBackoff(undefined, [{ messageId: 'msg-1' }], noJitterConfig);

				assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: 'RecordNotFound' }]);
			});

			it('Should fail the messages with an invalid eventSourceARN without calling SQS', async () => {

				const result = await applyRetryBackoff([buildRecord(1, { eventSourceARN: 'foo' })], [{ messageId: 'msg-1' }], noJitterConfig);

				assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 0);
				assert.deepStrictEqual(result.failures, [{ messageId: 'msg-1', errorCode: 'InvalidEventSourceARN' }]);
			});

			it('Should skip FIFO queues and flag them', async () => {

				const records = [
					buildRecord(1, { eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo' }),
					buildRecord(2)
				];

				const result = await applyRetryBackoff(records, records.map(({ messageId }) => ({ messageId })), noJitterConfig);

				assert.strictEqual(result.fifo, true);
				assert.strictEqual(result.summary.applied, 1);
				assert.deepStrictEqual(getEntries().Entries.map(({ ReceiptHandle }) => ReceiptHandle), ['handle-2']);
			});

			it('Should not call SQS when every message is FIFO', async () => {

				const result = await applyRetryBackoff(
					[buildRecord(1, { eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo' })],
					[{ messageId: 'msg-1' }],
					noJitterConfig
				);

				assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 0);
				assert.strictEqual(result.fifo, true);
				assert.deepStrictEqual(result.failures, []);
			});
		});
	});
});
