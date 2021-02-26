'use strict';

const SQSConsumer = require('./sqs-consumer');

module.exports = class IterativeSQSConsumer extends SQSConsumer {

	handlesBatch() {
		return false;
	}

};
