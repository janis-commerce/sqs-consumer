'use strict';

const BatchSQSConsumer = require('./batch-sqs-consumer');
const IterativeSQSConsumer = require('./iterative-sqs-consumer');
const SQSConsumer = require('./sqs-consumer');
const SQSHandler = require('./sqs-handler');

module.exports = {
	SQSHandler,
	SQSConsumer,
	IterativeSQSConsumer,
	BatchSQSConsumer
};
