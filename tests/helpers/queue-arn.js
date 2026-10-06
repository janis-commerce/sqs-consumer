'use strict';

const assert = require('assert');

const QueueArn = require('../../lib/helpers/queue-arn');

describe('QueueArn', () => {

	describe('parse', () => {

		it('Should return the queue url, the region and the fifo flag', () => {

			assert.deepStrictEqual(QueueArn.parse('arn:aws:sqs:us-east-1:123456789012:MyQueue'), {
				queueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
				region: 'us-east-1',
				fifo: false
			});
		});

		it('Should detect FIFO queues', () => {

			assert.strictEqual(QueueArn.parse('arn:aws:sqs:us-east-1:123456789012:MyQueue.fifo').fifo, true);
		});

		[undefined, null, 123, '', 'foo', 'arn:aws:s3:us-east-1:123456789012:MyQueue', 'arn:aws:sqs:us-east-1:123456789012',
			'arn:aws:sqs::123456789012:MyQueue', 'arn:aws:sqs:us-east-1::MyQueue'
		].forEach(arn => {

			it(`Should return null for ${JSON.stringify(arn)}`, () => {
				assert.strictEqual(QueueArn.parse(arn), null);
			});
		});
	});
});
