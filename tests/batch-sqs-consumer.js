'use strict';

const assert = require('assert');
const { BatchSQSConsumer, SQSConsumer } = require('../lib');

describe('Batch SQS Consumer', () => {

	describe('handlesBatch', () => {
		it('Should return true', () => {
			const batchConsumer = new BatchSQSConsumer();
			assert.strictEqual(batchConsumer.handlesBatch(), true);
		});
	});

	describe('inheritance', () => {
		it('Should extend the base SQSConsumer', () => {
			const batchConsumer = new BatchSQSConsumer();
			assert(batchConsumer instanceof SQSConsumer);
		});
	});

});
