'use strict';

const { struct } = require('@janiscommerce/superstruct');

module.exports.SQSEventStruct = struct({
	Records: [struct.partial({
		messageId: 'string',
		body: 'string',
		receiptHandle: 'string',
		eventSourceARN: 'string',
		messageAttributes: struct.optional('object')
	})]
});
