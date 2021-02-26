'use strict';

const assert = require('assert');
const { IterativeSQSConsumer, SQSConsumer } = require('../lib');

describe('Iterative SQS Consumer', () => {

	describe('handlesBatch', () => {
		it('Should return false', () => {
			const iterativeConsumer = new IterativeSQSConsumer();
			assert.strictEqual(iterativeConsumer.handlesBatch(), false);
		});
	});

	describe('inheritance', () => {
		it('Should extend the base SQSConsumer', () => {
			const iterativeConsumer = new IterativeSQSConsumer();
			assert(iterativeConsumer instanceof SQSConsumer);
		});
	});

});
