/* eslint-disable max-classes-per-file */

'use strict';

const sinon = require('sinon');
const assert = require('assert');

const { struct } = require('@janiscommerce/superstruct');
const Events = require('@janiscommerce/events');
const Log = require('@janiscommerce/log');

const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { SQSClient, ChangeMessageVisibilityBatchCommand } = require('@aws-sdk/client-sqs');
const lllog = require('lllog');

const { SQSHandler, SQSConsumer, SQSHandlerError } = require('../lib');
const LogTransport = require('../lib/log-transport');
const RetryBackoff = require('../lib/helpers/retry-backoff');

const eventWithoutClient = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' })
		},
		{
			messageId: '5dea9fc691240d00084083f9',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Bar' })
		}
	]
};

const eventWithOneClient = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'fizzmodarg',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		}
	]
};

const eventWithMultipleClientsAndWithoutClient = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'fizzmodarg',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		},
		{
			messageId: '5dea9fc691240d00084083f9',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'test',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		},
		{
			messageId: '5dea9fc691240d00084083c9',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'test',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		},
		{
			messageId: '5dea9fc691240d00084083a5',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' })
		}
	]
};

const eventWithMultipleClients = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'fizzmodarg',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		},
		{
			messageId: '5dea9fc691240d00084083f9',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ name: 'Foo' }),
			messageAttributes: {
				'janis-client': {
					stringValue: 'test',
					stringListValues: [],
					binaryListValues: [],
					dataType: 'String'
				}
			}
		}
	]
};

const eventSingleWithIncorrectBody = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ otherProperty: 'Foo' })
		}
	]
};

const eventBatchWithIncorrectBody = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ otherProperty: 'Foo' })
		},
		{
			messageId: '5dea9fc691240d00084083f9',
			receiptHandle: 'receipt handle',
			eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
			body: JSON.stringify({ otherProperty: 'Foo' })
		}
	]
};

class BatchConsumer extends SQSConsumer {
	handlesBatch() {
		return true;
	}
}

class ConditionalConsumer extends SQSConsumer {
	handlesBatch(eventData) {
		return eventData.Records.length > 1;
	}
}

class ConditionalConsumerWithStruct extends ConditionalConsumer {
	get struct() {
		return struct.partial({
			name: 'string'
		});
	}
}

class ConditionalConsumerWithArrayStruct extends ConditionalConsumer {
	get struct() {
		return [struct.partial({
			name: 'string'
		})];
	}
}

describe('SQS Handler', () => {

	let s3Mock;

	const contentS3Location = {
		bucketName: 'sample-bucket-name-us-east-1',
		region: 'us-east-1',
		path: 'sqsContent/defaultClient/service-name/MySQSName/2025/03/06/123.json'
	};

	beforeEach(() => {
		s3Mock = mockClient(S3Client);
		sinon.stub(SQSConsumer.prototype, 'processBatch');
		sinon.stub(SQSConsumer.prototype, 'processSingleRecord');
		sinon.spy(ConditionalConsumer.prototype, 'handlesBatch');
		sinon.stub(Events, 'emit');
		sinon.stub(Log, 'start');
	});

	afterEach(() => {
		s3Mock.restore();
		sinon.restore();
	});

	const assertS3GetObjectCommand = (callsNumber = 1) => {
		assert.deepStrictEqual(s3Mock.commandCalls(GetObjectCommand, {
			Bucket: contentS3Location.bucketName,
			Key: contentS3Location.path
		}, true).length, callsNumber);
	};

	describe('handle', () => {

		it('Should set the AWS_LAMBDA_REQUEST_ID env var with the context awsRequestId', async () => {

			await SQSHandler.handle(SQSConsumer, eventWithoutClient, { awsRequestId: 'test-request-id' });

			assert.strictEqual(process.env.AWS_LAMBDA_REQUEST_ID, 'test-request-id');
		});

		it('Should set the AWS_LAMBDA_REQUEST_ID env var as empty if no context is received', async () => {

			process.env.AWS_LAMBDA_REQUEST_ID = 'stale-request-id';

			await SQSHandler.handle(SQSConsumer, eventWithoutClient);

			assert.strictEqual(process.env.AWS_LAMBDA_REQUEST_ID, '');
		});

		it('Should call the processSingleRecord for each record if consumer does not handle batches', async () => {
			await SQSHandler.handle(SQSConsumer, eventWithoutClient);

			sinon.assert.notCalled(SQSConsumer.prototype.processBatch);
			sinon.assert.calledTwice(SQSConsumer.prototype.processSingleRecord);
			sinon.assert.calledWithExactly(SQSConsumer.prototype.processSingleRecord.getCall(0), {
				messageId: '5dea9fc691240d00084083f8',
				receiptHandle: 'receipt handle',
				eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
				body: { name: 'Foo' }
			}, sinon.match(logger => logger instanceof LogTransport));
			sinon.assert.calledWithExactly(SQSConsumer.prototype.processSingleRecord.getCall(1), {
				messageId: '5dea9fc691240d00084083f9',
				receiptHandle: 'receipt handle',
				eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
				body: { name: 'Bar' }
			}, sinon.match(logger => logger instanceof LogTransport));

			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should call the processSingleRecord for a record (with content S3 path)', async () => {

			const bodyContent = JSON.stringify({ name: 'Foo', otherData: 'some-data' });

			s3Mock.on(GetObjectCommand).resolves({
				Body: {
					transformToString: () => Promise.resolve(bodyContent)
				}
			});

			await SQSHandler.handle(SQSConsumer, {
				Records: [{
					messageId: '5dea9fc691240d00084083f8',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: JSON.stringify({ name: 'Foo', contentS3Location })
				}]
			});

			sinon.assert.notCalled(SQSConsumer.prototype.processBatch);
			sinon.assert.calledWithExactly(SQSConsumer.prototype.processSingleRecord, {
				messageId: '5dea9fc691240d00084083f8',
				receiptHandle: 'receipt handle',
				eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
				body: { name: 'Foo', otherData: 'some-data' }
			}, sinon.match(logger => logger instanceof LogTransport));

			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);

			assertS3GetObjectCommand();
		});

		it('Should call the processBatch with all records if consumer handles batches', async () => {
			await SQSHandler.handle(BatchConsumer, eventWithoutClient);

			sinon.assert.notCalled(BatchConsumer.prototype.processSingleRecord);
			sinon.assert.calledOnceWithExactly(BatchConsumer.prototype.processBatch, [
				{
					messageId: '5dea9fc691240d00084083f8',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: { name: 'Foo' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				},
				{
					messageId: '5dea9fc691240d00084083f9',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: { name: 'Bar' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				}
			]);

			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should call the processBatch with all records if consumer handles batches (one record with content S3 path)', async () => {

			const bodyContent = JSON.stringify({ name: 'Foo', otherData: 'some-data' });

			s3Mock.on(GetObjectCommand).resolves({
				Body: {
					transformToString: () => Promise.resolve(bodyContent)
				}
			});

			await SQSHandler.handle(BatchConsumer, {
				Records: [
					{
						messageId: '5dea9fc691240d00084083f8',
						receiptHandle: 'receipt handle',
						eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
						body: JSON.stringify({ name: 'Foo', contentS3Location })
					},
					{
						messageId: '5dea9fc691240d00084083f9',
						receiptHandle: 'receipt handle',
						eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
						body: JSON.stringify({ name: 'Bar' })
					}
				]
			});

			sinon.assert.notCalled(BatchConsumer.prototype.processSingleRecord);
			sinon.assert.calledOnceWithExactly(BatchConsumer.prototype.processBatch, [
				{
					messageId: '5dea9fc691240d00084083f8',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: { name: 'Foo', otherData: 'some-data' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				},
				{
					messageId: '5dea9fc691240d00084083f9',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: { name: 'Bar' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				}
			]);

			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);

			assertS3GetObjectCommand();
		});

		it('Should pass the event to the handlesBatch method of the consumer', async () => {
			await SQSHandler.handle(ConditionalConsumer, eventWithoutClient);
			sinon.assert.calledOnceWithExactly(ConditionalConsumer.prototype.handlesBatch, eventWithoutClient);
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should pass the event to the consumer with the session is setted', async () => {
			sinon.spy(ConditionalConsumer.prototype, 'setSession');
			await SQSHandler.handle(ConditionalConsumer, eventWithOneClient);
			sinon.assert.calledOnceWithExactly(ConditionalConsumer.prototype.setSession, { clientCode: 'fizzmodarg' });
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should pass the event to the consumer with the session set for each of them', async () => {
			sinon.spy(ConditionalConsumer.prototype, 'setSession');
			await SQSHandler.handle(ConditionalConsumer, eventWithMultipleClients);
			sinon.assert.calledTwice(ConditionalConsumer.prototype.setSession);
			sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(0), { clientCode: 'fizzmodarg' });
			sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(1), { clientCode: 'test' });
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should pass the event to the consumer with the sessions set only for the records with janis-client and omitted for the records without it',
			async () => {
				sinon.spy(ConditionalConsumer.prototype, 'setSession');
				await SQSHandler.handle(ConditionalConsumer, eventWithMultipleClientsAndWithoutClient);
				sinon.assert.calledTwice(ConditionalConsumer.prototype.setSession);
				sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(0), { clientCode: 'fizzmodarg' });
				sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(1), { clientCode: 'test' });
				sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
				sinon.assert.calledOnceWithExactly(Log.start);
			});

		it('Should process if the body structure in the records are valid', async () => {
			await assert.doesNotReject(SQSHandler.handle(ConditionalConsumerWithStruct, eventWithoutClient));
			await assert.doesNotReject(SQSHandler.handle(ConditionalConsumerWithArrayStruct, eventWithoutClient));
			sinon.assert.calledTwice(Events.emit);
			sinon.assert.alwaysCalledWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledTwice(Log.start);
			sinon.assert.alwaysCalledWithExactly(Log.start);
		});

		it('Should reject if the body structure of the records are invalid when processing a batch', async () => {
			await assert.rejects(SQSHandler.handle(ConditionalConsumerWithStruct, eventBatchWithIncorrectBody));
			sinon.assert.notCalled(ConditionalConsumerWithStruct.prototype.processBatch);
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should reject if the body structure of the records are invalid when processing one by one', async () => {
			await assert.rejects(SQSHandler.handle(ConditionalConsumerWithStruct, eventSingleWithIncorrectBody));
			sinon.assert.notCalled(ConditionalConsumerWithStruct.prototype.processSingleRecord);
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);
		});

		it('Should reject when an error occurs while getting body content from S3 bucket of AWS', async () => {

			s3Mock.on(GetObjectCommand).rejects(
				new Error('Failed to download from bucket', SQSHandlerError.codes.S3_ERROR)
			);

			await assert.rejects(SQSHandler.handle(SQSConsumer, {
				Records: [{
					messageId: '5dea9fc691240d00084083f8',
					receiptHandle: 'receipt handle',
					eventSourceARN: 'arn:aws:sqs:us-east-1:000000000000:FakeQueue',
					body: JSON.stringify({ name: 'Foo', contentS3Location })
				}]
			}));

			sinon.assert.notCalled(SQSConsumer.prototype.processSingleRecord);
			sinon.assert.calledOnceWithExactly(Events.emit, 'janiscommerce.ended');
			sinon.assert.calledOnceWithExactly(Log.start);

			assertS3GetObjectCommand();
		});

		// https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting
		describe('Partial failure reporting', () => {

			it('Should not return partial failure reporting if no failed messages are set', async () => {

				class NoReportConsumer extends BatchConsumer {
					handlesBatch() {
						return true;
					}
				}

				const response = await SQSHandler.handle(NoReportConsumer, eventWithOneClient);

				assert.deepStrictEqual(response, undefined);
			});

			it('Should return the partial failure reporting if at least one failed message is set', async () => {

				class NoReportConsumer extends BatchConsumer {
					processBatch(records) {
						this.addFailedMessage(records[0].messageId);
					}
				}

				const response = await SQSHandler.handle(NoReportConsumer, eventWithOneClient);

				assert.deepStrictEqual(response, {
					batchItemFailures: [
						{
							itemIdentifier: eventWithOneClient.Records[0].messageId
						}
					]
				});
			});

		});
	});

	describe('Retry backoff', () => {

		const QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:FakeQueue';
		const OTHER_QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:OtherQueue';
		const FIFO_QUEUE_ARN = 'arn:aws:sqs:us-east-1:000000000000:FakeQueue.fifo';

		const ACCESS_DENIED_MESSAGE = 'retryBackoff requires sqs:ChangeMessageVisibility: update sls-helper-plugin-janis >= 11.6.0';

		const config = { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2 };

		let sqsMock;

		const logs = {};

		const loggerPrototype = Object.getPrototypeOf(lllog());

		const buildRecord = (id, { arn = QUEUE_ARN, attempt = 1 } = {}) => ({
			messageId: `msg-${id}`,
			receiptHandle: `handle-${id}`,
			eventSourceARN: arn,
			attributes: { ApproximateReceiveCount: String(attempt) },
			body: JSON.stringify({ name: 'Foo' })
		});

		const buildEvent = (count, options) => ({
			Records: Array.from({ length: count }, (value, index) => buildRecord(index + 1, options))
		});

		const buildConsumer = ({
			retryBackoff, failedIds = [], minDelays = {}, error, batch = true
		} = {}) => {

			const process = function(records) {

				if(error)
					throw error;

				records.forEach(({ messageId }) => {
					if(failedIds.includes(messageId))
						this.addFailedMessage(messageId, minDelays[messageId] && { minDelaySeconds: minDelays[messageId] });
				});
			};

			return class BackoffConsumer extends SQSConsumer {

				get retryBackoff() {
					return retryBackoff;
				}

				handlesBatch() {
					return batch;
				}

				processBatch(records) {
					return process.call(this, records);
				}

				processSingleRecord(record) {
					return process.call(this, [record]);
				}
			};
		};

		const getVisibilityEntries = () => sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand)
			.flatMap(({ args: [command] }) => command.input.Entries);

		const assertSQSNotCalled = () => assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 0);

		beforeEach(() => {
			sqsMock = mockClient(SQSClient);
			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Successful: [], Failed: [] });
			RetryBackoff.resetClients();
			SQSHandler.resetRetryBackoffState();
			sinon.stub(Math, 'random').returns(0.5);
			logs.info = sinon.stub(loggerPrototype, 'info');
			logs.warn = sinon.stub(loggerPrototype, 'warn');
			logs.error = sinon.stub(loggerPrototype, 'error');
		});

		afterEach(() => {
			sqsMock.restore();
			RetryBackoff.resetClients();
			SQSHandler.resetRetryBackoffState();
		});

		it('Should return the same failures and not call SQS nor the helper if there is no retryBackoff getter', async () => {

			sinon.spy(RetryBackoff, 'applyRetryBackoff');
			sinon.spy(RetryBackoff, 'normalizeConfig');

			class DuplicatedConsumer extends BatchConsumer {
				processBatch() {
					['msg-1', 'msg-1', 'msg-2'].forEach(messageId => this.addFailedMessage(messageId));
				}
			}

			const response = await SQSHandler.handle(DuplicatedConsumer, buildEvent(2));

			assert.deepStrictEqual(response, {
				batchItemFailures: [
					{ itemIdentifier: 'msg-1' },
					{ itemIdentifier: 'msg-1' },
					{ itemIdentifier: 'msg-2' }
				]
			});

			assertSQSNotCalled();
			sinon.assert.notCalled(RetryBackoff.applyRetryBackoff);
			sinon.assert.notCalled(RetryBackoff.normalizeConfig);
			sinon.assert.notCalled(logs.info);
			sinon.assert.notCalled(logs.warn);
			sinon.assert.notCalled(logs.error);
		});

		it('Should not call SQS nor the helper if there are no failed messages', async () => {

			sinon.spy(RetryBackoff, 'applyRetryBackoff');

			const response = await SQSHandler.handle(buildConsumer({ retryBackoff: config }), buildEvent(3));

			assert.strictEqual(response, undefined);
			assertSQSNotCalled();
			sinon.assert.notCalled(RetryBackoff.applyRetryBackoff);
			sinon.assert.notCalled(logs.info);
		});

		it('Should change the visibility only of the failed messages with the exponential delay of their attempt', async () => {

			const event = {
				Records: [
					buildRecord(1, { attempt: 1 }),
					buildRecord(2, { attempt: 3 }),
					buildRecord(3, { attempt: 2 })
				]
			};

			const response = await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1', 'msg-2'] }), event);

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }, { itemIdentifier: 'msg-2' }] });

			sinon.assert.calledOnce(sqsMock.send);

			const [{ args: [command] }] = sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand);

			assert.deepStrictEqual(command.input, {
				QueueUrl: 'https://sqs.us-east-1.amazonaws.com/000000000000/FakeQueue',
				Entries: [
					{ Id: '0', ReceiptHandle: 'handle-1', VisibilityTimeout: 60 },
					{ Id: '1', ReceiptHandle: 'handle-2', VisibilityTimeout: 240 }
				]
			});
		});

		it('Should apply the jitter to the delay', async () => {

			Math.random.returns(1);

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] }), buildEvent(1));

			assert.deepStrictEqual(getVisibilityEntries().map(({ VisibilityTimeout }) => VisibilityTimeout), [72]);
		});

		it('Should use the default config if the getter returns an empty object', async () => {

			await SQSHandler.handle(buildConsumer({ retryBackoff: {}, failedIds: ['msg-1'] }), buildEvent(1));

			assert.deepStrictEqual(getVisibilityEntries().map(({ VisibilityTimeout }) => VisibilityTimeout), [60]);
		});

		it('Should cap the delay with maxDelaySeconds', async () => {

			await SQSHandler.handle(
				buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] }),
				{ Records: [buildRecord(1, { attempt: 20 })] }
			);

			assert.deepStrictEqual(getVisibilityEntries().map(({ VisibilityTimeout }) => VisibilityTimeout), [900]);
		});

		it('Should raise the delay up to minDelaySeconds and cap the floor with maxDelaySeconds', async () => {

			const Consumer = buildConsumer({
				retryBackoff: config,
				failedIds: ['msg-1', 'msg-2', 'msg-3'],
				minDelays: { 'msg-1': 300, 'msg-2': 5000 }
			});

			await SQSHandler.handle(Consumer, buildEvent(3));

			assert.deepStrictEqual(getVisibilityEntries().map(({ VisibilityTimeout }) => VisibilityTimeout), [300, 900, 60]);
		});

		it('Should use the last minDelaySeconds of a repeated failed message and keep the duplicated batchItemFailures', async () => {

			class RepeatedConsumer extends BatchConsumer {

				get retryBackoff() {
					return config;
				}

				processBatch() {
					this.addFailedMessage('msg-1', { minDelaySeconds: 500 });
					this.addFailedMessage('msg-1', { minDelaySeconds: 200 });
				}
			}

			const response = await SQSHandler.handle(RepeatedConsumer, buildEvent(1));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }, { itemIdentifier: 'msg-1' }] });
			assert.deepStrictEqual(getVisibilityEntries().map(({ VisibilityTimeout }) => VisibilityTimeout), [200]);
		});

		it('Should call SQS in chunks of 10 messages if there are more than 10 failed messages', async () => {

			const failedIds = Array.from({ length: 23 }, (value, index) => `msg-${index + 1}`);

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds }), buildEvent(25));

			const sizes = sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).map(({ args: [command] }) => command.input.Entries.length);

			assert.deepStrictEqual(sizes, [10, 10, 3]);
		});

		it('Should call SQS once for each queue if the failed messages belong to different queues', async () => {

			const event = {
				Records: [
					buildRecord(1),
					buildRecord(2, { arn: OTHER_QUEUE_ARN }),
					buildRecord(3)
				]
			};

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1', 'msg-2', 'msg-3'] }), event);

			const queueUrls = sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).map(({ args: [command] }) => command.input.QueueUrl);

			assert.deepStrictEqual(queueUrls.sort(), [
				'https://sqs.us-east-1.amazonaws.com/000000000000/FakeQueue',
				'https://sqs.us-east-1.amazonaws.com/000000000000/OtherQueue'
			]);
		});

		it('Should log a summary of the invocation', async () => {

			const event = {
				Records: [buildRecord(1, { attempt: 1 }), buildRecord(2, { attempt: 3 })]
			};

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1', 'msg-2'] }), event);

			sinon.assert.calledOnceWithExactly(logs.info, 'retryBackoff applied', {
				applied: 2,
				failures: 0,
				minAttempt: 1,
				maxAttempt: 3,
				minDelay: 60,
				maxDelay: 240
			});

			sinon.assert.notCalled(logs.warn);
			sinon.assert.notCalled(logs.error);
		});

		it('Should keep the messages in batchItemFailures and warn if SQS reports partial failures', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({
				Successful: [{ Id: '0' }],
				Failed: [{ Id: '1', Code: 'ReceiptHandleIsInvalid', Message: 'Invalid', SenderFault: true }]
			});

			const response = await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1', 'msg-2'] }), buildEvent(2));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }, { itemIdentifier: 'msg-2' }] });

			sinon.assert.calledOnce(logs.warn);
			sinon.assert.calledWithMatch(logs.warn, 'retryBackoff could not change the visibility of 1 messages', {
				failures: [{ messageId: 'msg-2', errorCode: 'ReceiptHandleIsInvalid', errorMessage: 'Invalid' }]
			});
			sinon.assert.calledWithMatch(logs.info, 'retryBackoff applied', { applied: 2, failures: 1 });
			sinon.assert.notCalled(logs.error);
		});

		it('Should keep the messages in batchItemFailures and warn only some failures if the SQS call rejects', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(new Error('Network error'));

			const failedIds = Array.from({ length: 8 }, (value, index) => `msg-${index + 1}`);

			const response = await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds }), buildEvent(8));

			assert.strictEqual(response.batchItemFailures.length, 8);

			sinon.assert.calledOnce(logs.warn);
			sinon.assert.calledWithMatch(logs.warn, 'retryBackoff could not change the visibility of 8 messages', {
				omittedFailures: 3
			});
			assert.strictEqual(logs.warn.firstCall.args[1].failures.length, 5);
			sinon.assert.notCalled(logs.error);
		});

		it('Should log a single error and not call SQS again in the next invocations if access is denied', async () => {

			const accessDenied = new Error('Not allowed');
			accessDenied.name = 'AccessDenied';
			sqsMock.on(ChangeMessageVisibilityBatchCommand).rejects(accessDenied);

			const Consumer = buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] });

			const response = await SQSHandler.handle(Consumer, buildEvent(1));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
			sinon.assert.calledOnceWithExactly(logs.error, ACCESS_DENIED_MESSAGE);
			assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 1);

			const secondResponse = await SQSHandler.handle(Consumer, buildEvent(1));

			assert.deepStrictEqual(secondResponse, { batchItemFailures: [{ itemIdentifier: 'msg-1' }] });
			sinon.assert.calledOnce(logs.error);
			assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 1);
		});

		it('Should keep the backoff enabled in other consumers if access is denied in one of them', async () => {

			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolvesOnce({
				Failed: [{ Id: '0', Code: 'AccessDenied', SenderFault: true }]
			});

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] }), buildEvent(1));

			sqsMock.on(ChangeMessageVisibilityBatchCommand).resolves({ Successful: [{ Id: '0' }], Failed: [] });

			await SQSHandler.handle(buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] }), buildEvent(1));

			assert.strictEqual(sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).length, 2);
		});

		it('Should not call SQS and warn only once per container if the queue is FIFO', async () => {

			const Consumer = buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] });

			const response = await SQSHandler.handle(Consumer, buildEvent(1, { arn: FIFO_QUEUE_ARN }));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }] });

			await SQSHandler.handle(Consumer, buildEvent(1, { arn: FIFO_QUEUE_ARN }));

			assertSQSNotCalled();
			sinon.assert.calledOnce(logs.warn);
			sinon.assert.calledWithMatch(logs.warn, 'not supported in FIFO');
			sinon.assert.notCalled(logs.info);
			sinon.assert.notCalled(logs.error);
		});

		it('Should not call SQS if the handler rejects', async () => {

			sinon.spy(RetryBackoff, 'applyRetryBackoff');

			class FailingConsumer extends BatchConsumer {

				get retryBackoff() {
					return config;
				}

				processBatch() {
					this.addFailedMessage('msg-1');
					throw new Error('Handler error');
				}
			}

			await assert.rejects(SQSHandler.handle(FailingConsumer, buildEvent(1)), { message: 'Handler error' });

			assertSQSNotCalled();
			sinon.assert.notCalled(RetryBackoff.applyRetryBackoff);
		});

		it('Should log a single error and not call SQS if the config is invalid', async () => {

			const Consumer = buildConsumer({ retryBackoff: { baseDelaySeconds: 0 }, failedIds: ['msg-1'] });

			const response = await SQSHandler.handle(Consumer, buildEvent(1));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-1' }] });

			await SQSHandler.handle(Consumer, buildEvent(1));

			assertSQSNotCalled();
			sinon.assert.calledOnceWithExactly(logs.error, 'Invalid retryBackoff config, backoff disabled: baseDelaySeconds must be greater than 0');
		});

		it('Should apply the backoff only to the messages added as failed if the consumer handles records one by one', async () => {

			const Consumer = buildConsumer({ retryBackoff: config, failedIds: ['msg-2'], minDelays: { 'msg-2': 120 }, batch: false });

			const response = await SQSHandler.handle(Consumer, buildEvent(3));

			assert.deepStrictEqual(response, { batchItemFailures: [{ itemIdentifier: 'msg-2' }] });

			assert.deepStrictEqual(getVisibilityEntries(), [
				{ Id: '0', ReceiptHandle: 'handle-2', VisibilityTimeout: 120 }
			]);
		});

		it('Should reset the failed delays on each invocation', async () => {

			const Consumer = buildConsumer({ retryBackoff: config, failedIds: ['msg-1'] });

			await SQSHandler.handle(Consumer, buildEvent(1));
			await SQSHandler.handle(Consumer, buildEvent(1));

			assert.deepStrictEqual(
				sqsMock.commandCalls(ChangeMessageVisibilityBatchCommand).map(({ args: [command] }) => command.input.Entries.length),
				[1, 1]
			);
		});
	});

});
