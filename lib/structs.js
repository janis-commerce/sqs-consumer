'use strict';

const { struct } = require('@janiscommerce/superstruct');

module.exports.SQSEventStruct = struct({
	Records: [{
		messageId: 'string',
		body: 'string',
		messageAttributes: struct.optional('object')
	}]
});
