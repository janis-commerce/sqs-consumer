'use strict';

const sinon = require('sinon');
const { SQSHandler, SQSConsumer } = require('../lib');
const LogTransport = require('../lib/log-transport');

const event = {
	Records: [
		{
			messageId: '5dea9fc691240d00084083f8',
			body: JSON.stringify({ name: 'Foo' })
		},
		{
			messageId: '5dea9fc691240d00084083f9',
			body: JSON.stringify({ name: 'Bar' })
		}
	]
};

class BatchConsumer extends SQSConsumer {
	handlesBatch() {
		return true;
	}
}

describe('SQS Handler', () => {

	beforeEach(() => {
		sinon.stub(SQSConsumer.prototype, 'processBatch');
		sinon.stub(SQSConsumer.prototype, 'processSingleRecord');
	});

	afterEach(() => sinon.restore());

	describe('handle', () => {

		it('Should call the processSingleRecord for each record if consumer does not handle batches', async () => {
			await SQSHandler.handle(SQSConsumer, event);

			sinon.assert.notCalled(SQSConsumer.prototype.processBatch);
			sinon.assert.calledTwice(SQSConsumer.prototype.processSingleRecord);
			sinon.assert.calledWithExactly(SQSConsumer.prototype.processSingleRecord.getCall(0), {
				messageId: '5dea9fc691240d00084083f8',
				body: { name: 'Foo' }
			}, sinon.match(logger => logger instanceof LogTransport));
			sinon.assert.calledWithExactly(SQSConsumer.prototype.processSingleRecord.getCall(1), {
				messageId: '5dea9fc691240d00084083f9',
				body: { name: 'Bar' }
			}, sinon.match(logger => logger instanceof LogTransport));
		});

		it('Should call the processBatch with all records if consumer handles batches', async () => {
			await SQSHandler.handle(BatchConsumer, event);

			sinon.assert.notCalled(BatchConsumer.prototype.processSingleRecord);
			sinon.assert.calledOnceWithExactly(BatchConsumer.prototype.processBatch, [
				{
					messageId: '5dea9fc691240d00084083f8',
					body: { name: 'Foo' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				},
				{
					messageId: '5dea9fc691240d00084083f9',
					body: { name: 'Bar' },
					[Symbol.for('logger')]: sinon.match(logger => logger instanceof LogTransport)
				}
			]);
		});

	});

});
