'use strict';

const sinon = require('sinon');
const assert = require('assert');
const { struct } = require('@janiscommerce/superstruct');
const { SQSHandler, SQSConsumer } = require('../lib');
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

	beforeEach(() => {
		sinon.stub(SQSConsumer.prototype, 'processBatch');
		sinon.stub(SQSConsumer.prototype, 'processSingleRecord');
		sinon.spy(ConditionalConsumer.prototype, 'handlesBatch');
	});

	afterEach(() => sinon.restore());

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
		});

		it('Should pass the event to the handlesBatch method of the consumer', async () => {
			await SQSHandler.handle(ConditionalConsumer, eventWithoutClient);
			sinon.assert.calledOnceWithExactly(ConditionalConsumer.prototype.handlesBatch, eventWithoutClient);
		});

		it('Should pass the event by the consumer with the session is setted', async () => {
			sinon.spy(ConditionalConsumer.prototype, 'setSession');
			await SQSHandler.handle(ConditionalConsumer, eventWithOneClient);
			sinon.assert.calledOnceWithExactly(ConditionalConsumer.prototype.setSession, { clientCode: 'fizzmodarg' });
		});

		it('Should pass the event to the consumer with the session set for each of them', async () => {
			sinon.spy(ConditionalConsumer.prototype, 'setSession');
			await SQSHandler.handle(ConditionalConsumer, eventWithMultipleClients);
			sinon.assert.calledTwice(ConditionalConsumer.prototype.setSession);
			sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(0), { clientCode: 'fizzmodarg' });
			sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(1), { clientCode: 'test' });
		});

		it('Should pass the event to the consumer with the sessions set only for the records with janis-client and omitted for the records without it',
			async () => {
				sinon.spy(ConditionalConsumer.prototype, 'setSession');
				await SQSHandler.handle(ConditionalConsumer, eventWithMultipleClientsAndWithoutClient);
				sinon.assert.calledTwice(ConditionalConsumer.prototype.setSession);
				sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(0), { clientCode: 'fizzmodarg' });
				sinon.assert.calledWithExactly(ConditionalConsumer.prototype.setSession.getCall(1), { clientCode: 'test' });
			});

		it('Should process if the body structure in the records are valid', async () => {
			await assert.doesNotReject(SQSHandler.handle(ConditionalConsumerWithStruct, eventWithoutClient));
			await assert.doesNotReject(SQSHandler.handle(ConditionalConsumerWithArrayStruct, eventWithoutClient));
		});

		it('Should reject if the body structure of the records are invalid when processing a batch', async () => {
			await assert.rejects(SQSHandler.handle(ConditionalConsumerWithStruct, eventBatchWithIncorrectBody));
			sinon.assert.notCalled(ConditionalConsumerWithStruct.prototype.processBatch);
		});

		it('Should reject if the body structure of the records are invalid when processing one by one', async () => {
			await assert.rejects(SQSHandler.handle(ConditionalConsumerWithStruct, eventSingleWithIncorrectBody));
			sinon.assert.notCalled(ConditionalConsumerWithStruct.prototype.processSingleRecord);
		});
	});

});
