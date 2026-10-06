'use strict';

const assert = require('assert');
const sinon = require('sinon');
const { mockClient } = require('aws-sdk-client-mock');
const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');

const VisibilityChanger = require('../../lib/retry-backoff/visibility-changer');

describe('VisibilityChanger', () => {

	const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue';

	const buildChange = (id, extra = {}) => ({
		messageId: `msg-${id}`,
		receiptHandle: `handle-${id}`,
		queueUrl,
		region: 'us-east-1',
		attempt: 1,
		delaySeconds: 60,
		...extra
	});

	const buildChanges = count => Array.from({ length: count }, (value, index) => buildChange(index));

	let sqsMock;

	const getCalls = () => sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand);

	beforeEach(() => {
		sqsMock = mockClient(SQSClient);
		sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Successful: [], Failed: [] });
		VisibilityChanger.resetClients();
	});

	afterEach(() => {
		sqsMock.restore();
		sinon.restore();
	});

	describe('parseQueueArn', () => {

		it('Should return the queue url, the region and the fifo flag', () => {

			assert.deepStrictEqual(VisibilityChanger.parseQueueArn('arn:aws:sqs:us-east-1:123456789012:MyQueue'), {
				queueUrl,
				region: 'us-east-1',
				fifo: false
			});
		});

		it('Should detect FIFO queues', () => {

			assert.strictEqual(VisibilityChanger.parseQueueArn('arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo').fifo, true);
		});

		[undefined, null, 123, '', 'foo', 'arn:aws:s3:us-east-1:123456789012:MyQueue', 'arn:aws:sqs:us-east-1:123456789012',
			'arn:aws:sqs::123456789012:MyQueue', 'arn:aws:sqs:us-east-1::MyQueue'
		].forEach(arn => {

			it(`Should return null for ${JSON.stringify(arn)}`, () => {
				assert.strictEqual(VisibilityChanger.parseQueueArn(arn), null);
			});
		});
	});

	describe('change', () => {

		it('Should change the visibility with the delay of each message', async () => {

			const result = await VisibilityChanger.change([buildChange(1, { delaySeconds: 120 }), buildChange(2)]);

			sinon.assert.match(getCalls()[0].args[0].input, {
				QueueUrl: queueUrl,
				Entries: [
					{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 120 },
					{ Id: '1', ReceiptHandle: 'handle-2', VisibilityTimeout: 60 }
				]
			});

			assert.strictEqual(getCalls().length, 1);
			assert.deepStrictEqual(result, { accessDenied: false, failures: [] });
		});

		it('Should not call SQS when there are no changes', async () => {

			const result = await VisibilityChanger.change([]);

			assert.strictEqual(getCalls().length, 0);
			assert.deepStrictEqual(result, { accessDenied: false, failures: [] });
		});

		it('Should chunk the messages of a queue by 10, in parallel', async () => {

			await VisibilityChanger.change(buildChanges(25));

			assert.deepStrictEqual(getCalls().map(call => call.args[0].input.Entries.length), [10, 10, 5]);
			assert.deepStrictEqual(getCalls()[2].args[0].input.Entries.map(({ Id }) => Id), ['0', '1', '2', '3', '4']);
		});

		it('Should make one call per queue and a client per region', async () => {

			const otherQueueUrl = 'https://sqs.us-east-1.amazonaws.com/123456789012/OtherQueue';
			const otherRegionQueueUrl = 'https://sqs.us-west-2.amazonaws.com/123456789012/MyQueue';

			await VisibilityChanger.change([
				buildChange(1),
				buildChange(2, { queueUrl: otherQueueUrl }),
				buildChange(3, { queueUrl: otherRegionQueueUrl, region: 'us-west-2' }),
				buildChange(4)
			]);

			assert.deepStrictEqual(getCalls().map(call => call.args[0].input.QueueUrl), [queueUrl, otherQueueUrl, otherRegionQueueUrl]);
			assert.deepStrictEqual(getCalls().map(call => call.args[0].input.Entries.length), [2, 1, 1]);
			assert.deepStrictEqual(Object.keys(VisibilityChanger.clients), ['us-east-1', 'us-west-2']);
		});

		it('Should reuse the cached client of a region', async () => {

			await VisibilityChanger.change(buildChanges(11));

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

			const result = await VisibilityChanger.change([buildChange(1), buildChange(2)]);

			assert.deepStrictEqual(result, {
				accessDenied: false,
				failures: [
					{ messageId: 'msg-2', errorCode: 'ReceiptHandleIsInvalid', errorMessage: 'Invalid handle' },
					{ messageId: 'msg-1', errorCode: 'InternalError' }
				]
			});
		});

		it('Should handle a response without Failed', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({});

			const result = await VisibilityChanger.change([buildChange(1)]);

			assert.deepStrictEqual(result.failures, []);
		});

		it('Should return every message of the chunk as failed when the call throws, and never throw', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('boom'), { name: 'ServiceUnavailable' }));

			const result = await VisibilityChanger.change([buildChange(1), buildChange(2)]);

			assert.deepStrictEqual(result, {
				accessDenied: false,
				failures: [
					{ messageId: 'msg-1', errorCode: 'ServiceUnavailable', errorMessage: 'boom' },
					{ messageId: 'msg-2', errorCode: 'ServiceUnavailable', errorMessage: 'boom' }
				]
			});
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

			const result = await VisibilityChanger.change(buildChanges(11));

			assert.deepStrictEqual([...new Set(result.failures.map(({ errorCode }) => errorCode))].sort(), ['SomeCode', 'some_code']);
		});

		['AccessDenied', 'AccessDeniedException'].forEach(code => {

			it(`Should flag accessDenied when the call throws ${code} as name`, async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('denied'), { name: code }));

				const result = await VisibilityChanger.change([buildChange(1)]);

				assert.strictEqual(result.accessDenied, true);
				assert.strictEqual(result.failures.length, 1);
			});

			it(`Should flag accessDenied when the call throws ${code} as Code`, async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(Object.assign(new Error('denied'), { name: 'Error', Code: code }));

				const result = await VisibilityChanger.change([buildChange(1)]);

				assert.strictEqual(result.accessDenied, true);
			});

			it(`Should flag accessDenied when an entry fails with ${code}`, async () => {

				sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Failed: [{ Id: '0', Code: code }] });

				const result = await VisibilityChanger.change([buildChange(1)]);

				assert.deepStrictEqual(result, { accessDenied: true, failures: [{ messageId: 'msg-1', errorCode: code }] });
			});
		});
	});
});
