'use strict';

const SQSConsumer = require('./sqs-consumer');

module.exports = class BatchSQSConsumer extends SQSConsumer {

	handlesBatch() {
		return true;
	}

};
