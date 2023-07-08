# SQS Consumer

![Build Status](https://github.com/janis-commerce/sqs-consumer/workflows/Build%20Status/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/janis-commerce/sqs-consumer/badge.svg?branch=master)](https://coveralls.io/github/janis-commerce/sqs-consumer?branch=master)
[![npm version](https://badge.fury.io/js/%40janiscommerce%2Fsqs-consumer.svg)](https://www.npmjs.com/package/@janiscommerce/sqs-consumer)

A wrapper for SQS Consumers and Lambda

## :inbox_tray: Installation

```sh
npm install @janiscommerce/sqs-consumer
```

## :hammer: Usage

Your business logic must be implemented as a `SQSConsumer`. There are two types of consumers exported for implementation ease:

### BatchSQSConsumer

This consumer processes all the records in one single call. This is useful for example when you want to fetch some data using some field on every record.

For this consumer, you have to implement the `processBatch` method. The method signature is the following:

```js
processBatch(records: Array<ParsedSQSRecordWithLogger>): Promise<void> | void
```

To add a log message for a record, you can use the built-in logger like this:

```js
record[Symbol.for('logger')].info('Some info message');
```

> Logger has been implemented as a Symbol property to ensure that it won't collide with existing properties of the SQS Record

Logging levels follow [lllog](https://www.npmjs.com/package/lllog) levels.

### IterativeSQSConsumer

This consumer processes one record at a time. This is useful when records are completely unrelated and can be processed in parallel with no dependencies between them, or when you consume only one SQS message per invocation (batchSize = 1).

For this consumer, you have to implement the `processSingleRecord` method. The method signature is the following:

```js
processSingleRecord(record: ParsedSQSRecord, logger: LogTransport): Promise<void> | void
```

To add a log message for a record, you can use the logger passed as argument like this:

```js
logger.info('Some info message');
```

Logging levels follow [lllog](https://www.npmjs.com/package/lllog) levels.

### Partial failure reporting

To implement [Partial failure reporting](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting), you should add each message ID that fails using the method `addFailedMessage(messageId)`.

The lambda will automatically return the failed messages formatted as expected.

## :zap: Usage with serverless (lambda)

This package also exports a `SQSHandler` to easily integrate with AWS Lambda.

Usage is as easy as it can be, just export the following in your lambda:

```js
module.exports.handler = event => SQSHandler.handle(MySQSConsumer, event);
```

## :warning: Advanced usage

### Conditional processing

In case you want to process the messages in batch in some cases and individually in others, you can extend the `handlesBatch` method to implement your own custom logic. The method's signature is the following:

```js
handlesBatch(event: SQSEvent): boolean
```

> **Important**: This method must be synchronous

### Message formatting

This package expects each message body to be a JSON string and will fail if it's not.

In case you want to parse the records in a different way (or silently fail if format is invalid) you can override the `parseRecord` method. The method's signature is the following:

```js
parseRecord(record: SQSRecord): ParsedSQSRecord
```

> **Important**: This method must be synchronous

## :computer: Examples

### Lambda Batch consumer

> Process a batch of new ratings of a product and save them as not-verified

```js
const {
	SQSHandler,
	BatchSQSConsumer
} = require('@janiscommerce/sqs-consumer');

const DbHandler = require('./your-db-handler');

class MyBatchConsumer extends BatchSQSConsumer {

	async processBatch(records) {

		const ratings = records.map(({ body }) => ({
			rating: body.rating,
			verified: false
		}));

		return DbHandler.insertMany(ratings);
	}
}

module.exports.handler = event => SQSHandler.handle(MyBatchConsumer, event);
```

### Lambda Iterative consumer

> Process a batch of orders placed in you ecommerce and send an email for each of them

```js
const {
	SQSHandler,
	IterativeSQSConsumer
} = require('@janiscommerce/sqs-consumer');

const MailingService = require('./your-mailing-service');

class MyIterativeConsumer extends IterativeSQSConsumer {

	async processSingleRecord(record, logger) {

		const { body: orderPlaced } = record.body;

		logger.info(`Sending email for order ${orderPlaced.id}`);

		return MailingService.sendTemplate('orderPlaced', orderPlaced);
	}
}

module.exports.handler = event => SQSHandler.handle(MyIterativeConsumer, event);
```

### Validate with Struct (Optional)

When you declare a struct, before any process, all records are validated and only continue if pass the validation, this validations should return a valid [struct](https://www.npmjs.com/package/@janiscommerce/superstruct).

You must declare a get struct() in your class.

```js
const {
	SQSHandler,
	IterativeSQSConsumer
} = require('@janiscommerce/sqs-consumer');
const { struct } = require('@janiscommerce/superstruct');

class MyConsumer extends IterativeSQSConsumer {

	get struct() {
		return struct.partial({
			name: 'string'
		});
	}

}

module.exports.handler = event => SQSHandler.handle(MyConsumer, event);
```

### Session injection

This package implements [API Session](https://www.npmjs.com/package/@janiscommerce/api-session). In order to associate a request to a session, the record should be contain the property `janis-client` in the `messageAttributes`.

In case the `messageAttribute` is set, you can access the session in your `Consumer` as `this.session`. Otherwise, `this.session` will be `undefined`.

Session details and customization details can be found in api-session README.
