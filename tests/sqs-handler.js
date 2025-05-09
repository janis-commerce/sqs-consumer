/* eslint-disable max-classes-per-file */

'use strict';

const sinon = require('sinon');
const assert = require('assert');

const { struct } = require('@janiscommerce/superstruct');
const Events = require('@janiscommerce/events');
const Log = require('@janiscommerce/log');

const { mockClient } = require('aws-sdk-client-mock');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const { SQSHandler, SQSConsumer, SQSHandlerError } = require('../lib');
const LogTransport = require('../lib/log-transport');

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

});
