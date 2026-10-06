'use strict';

const assert = require('assert');

const sinon = require('sinon');

const QueueArn = require('../../lib/helpers/queue-arn');

describe('QueueArn', () => {

	describe('parse', () => {

		afterEach(() => {
			QueueArn.resetCache();
			sinon.restore();
		});

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

		it('Should parse each ARN only once', () => {

			sinon.spy(QueueArn, 'parseArn');

			const arn = 'arn:aws:sqs:us-east-1:123456789012:MyQueue';

			const first = QueueArn.parse(arn);

			assert.strictEqual(QueueArn.parse(arn), first);
			sinon.assert.calledOnceWithExactly(QueueArn.parseArn, arn);
		});

		it('Should cache invalid ARNs too', () => {

			sinon.spy(QueueArn, 'parseArn');

			assert.strictEqual(QueueArn.parse('foo'), null);
			assert.strictEqual(QueueArn.parse('foo'), null);
			sinon.assert.calledOnce(QueueArn.parseArn);
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
