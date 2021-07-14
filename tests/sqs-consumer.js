'use strict';

const { ApiSession } = require('@janiscommerce/api-session');
const assert = require('assert');
const { SQSConsumer } = require('../lib');
const LogTransport = require('../lib/log-transport');

describe('SQS Consumer', () => {

	describe('handlesBatch', () => {
		it('Should return false by default', () => {
			const myConsumer = new SQSConsumer();
			assert.strictEqual(myConsumer.handlesBatch(), false);
		});
	});

	describe('processBatch', () => {
		it('Should implement a dummy processBatch method', async () => {
			const myConsumer = new SQSConsumer();
			assert.doesNotReject(myConsumer.processBatch([{
				id: '5dea9fc691240d00084083f8',
				[Symbol.for('logger')]: new LogTransport('myPrefix')
			}]));
		});
	});

	describe('processSingleRecord', () => {
		it('Should implement a dummy processSingleRecord method', async () => {
			const myConsumer = new SQSConsumer();
			assert.doesNotReject(myConsumer.processSingleRecord({
				id: '5dea9fc691240d00084083f8'
			}, new LogTransport('myPrefix')));
		});
	});

	describe('setSession', () => {
		it('Should set a session in consumer correctly', async () => {
			const myConsumer = new SQSConsumer();
			const clientCode = 'clientTest';

			myConsumer.setSession({ clientCode });

			assert(myConsumer.session instanceof ApiSession);
			assert(myConsumer.session.clientCode === clientCode);
		});
	});

});
