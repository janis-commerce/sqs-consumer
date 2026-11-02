# SQS Consumer

![Build Status](https://github.com/janis-commerce/sqs-consumer/workflows/Build%20Status/badge.svg)
[![Coverage Status](https://coveralls.io/repos/github/janis-commerce/sqs-consumer/badge.svg?branch=master)](https://coveralls.io/github/janis-commerce/sqs-consumer?branch=master)
[![npm version](https://badge.fury.io/js/%40janiscommerce%2Fsqs-consumer.svg)](https://www.npmjs.com/package/@janiscommerce/sqs-consumer)

A wrapper for SQS Consumers and Lambda

## Breaking changes ⚠️

### 1.0.0
- When using this package with serverless, it's **mandatory** to use [`sls-helper-plugin-janis`](https://www.npmjs.com/package/sls-helper-plugin-janis) version **10.2.0** or higher to handle messages that exceed the SNS payload limit. This version is **required** to ensure proper permissions are set up.
- Additionally, it's **mandatory** to update [`@janiscommerce/sqs-emitter`](https://www.npmjs.com/package/@janiscommerce/sqs-emitter) to version **1.0.0** or higher and [`@janiscommerce/sns`](https://www.npmjs.com/package/@janiscommerce/sns) to version **2.0.0** or higher in any service that listens to events emitted by this package. This way, storage and retrieval of large payloads through S3 will be automatically handled when needed.

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

When processing each record, if the body received contains the property `contentS3Path`, the consumer will download from the S3 bucket the complete body and assign it to the parsed record to return.

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

When processing the single record, if the body received contains the property `contentS3Path`, the consumer will download from the S3 bucket the complete body and assign it to the parsed record to return.

To add a log message for a record, you can use the logger passed as argument like this:

```js
logger.info('Some info message');
```

Logging levels follow [lllog](https://www.npmjs.com/package/lllog) levels.

### Partial failure reporting

To implement [Partial failure reporting](https://docs.aws.amazon.com/lambda/latest/dg/with-sqs.html#services-sqs-batchfailurereporting), you should add each message ID that fails using the method `addFailedMessage(messageId)`.

The lambda will automatically return the failed messages formatted as expected.

### Retry backoff

By default, a failed message returns to the queue after the fixed visibility timeout of the queue. To delay each retry with an exponential backoff and jitter, define the `retryBackoff` getter in your consumer:

```js
class MyConsumer extends BatchSQSConsumer {

	get retryBackoff() {
		return { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2, jitterMode: 'upward' };
	}

	async processBatch(records) {
		// ...
		this.addFailedMessage(record.messageId);
	}
}
```

Every field is optional and the getter can return `{}` or `true`. The default values are the ones of the example. If the getter is not defined, or returns `undefined`, `null` or `false`, the backoff is disabled without logs and nothing changes.

| Field | Default | Description |
|-------|---------|-------------|
| `baseDelaySeconds` | `60` | Nominal delay of the first retry. Must be greater than 0 and not greater than `maxDelaySeconds` |
| `maxDelaySeconds` | `900` | Maximum delay. Must not be greater than `43200` (12 hours, the maximum visibility timeout of SQS). See [Long waits](#long-waits-up-to-12-hours) |
| `jitterRatio` | `0.2` | Random increase of the delay, from `0` to `jitterRatio` of it. Only used by `jitterMode: 'upward'`, but validated with every mode. Must be in the range `[0, 1)` |
| `jitterMode` | `'upward'` | How the random jitter is applied to the delay: `'upward'`, `'equal'` or `'full'`. See [Jitter modes](#jitter-modes) |

The delay in seconds of each failed message is calculated as follows:

```
N = min(maxDelaySeconds, baseDelaySeconds × 2^(attempt − 1))

upward: jittered = N × (1 + random × jitterRatio)
equal:  jittered = N / 2 + random × N / 2
full:   jittered = random × N

delay = min(maxDelaySeconds, ceil(max(minDelaySeconds, jittered)))
```

The nominal delay `N` is capped before the jitter, so the retries keep spreading once the formula exceeds `maxDelaySeconds`.

With the defaults (`upward`):

| Failed attempt | `60 × 2^(n−1)` | Applied delay (jitter +0–20 %, cap 900) | Accumulated (nominal) |
|----------------|----------------|------------------------------------------|-----------------------|
| 1 | 60 s | 60–72 s | 1 min |
| 2 | 120 s | 120–144 s | 3 min |
| 3 | 240 s | 240–288 s | 7 min |
| 4 | 480 s | 480–576 s | 15 min |
| 5 | 960 s | 900 s | 30 min |
| 6+ | ≥ 1920 s | 900 s | +15 min each |

- `attempt` is the `ApproximateReceiveCount` of the message (the first receive is `1`).
- `baseDelaySeconds` is the nominal delay of the first attempt. It is not a floor: with `equal` and `full` a retry can wait less than it.
- With `upward`, the jitter only increases the delay, so no retry happens before the nominal delay.
- `minDelaySeconds` is the explicit floor of each message. It is optional (default `0`) and is set with `addFailedMessage(messageId, { minDelaySeconds })`. The delay is at least that value. With `300` and the defaults, the attempts 1 to 3 wait `300` seconds. If the same message is added more than once, the last `minDelaySeconds` is used.

```js
this.addFailedMessage(record.messageId, { minDelaySeconds: 120 });
```

#### Jitter modes

The jitter spreads the retries of the messages that failed together. `jitterMode` defines its range for the nominal delay `N = min(maxDelaySeconds, baseDelaySeconds × 2^(attempt − 1))`, before rounding up and the cap:

| Mode | Range for a nominal `N` | Uses `jitterRatio` |
|------|-------------------------|--------------------|
| `upward` (default) | `[N, N × (1 + jitterRatio))` | Yes |
| `equal` | `[N / 2, N)` | No, it is ignored (but still validated) |
| `full` | `[0, N)` | No, it is ignored (but still validated) |

With `baseDelaySeconds: 30`, `maxDelaySeconds: 300` (and `jitterRatio: 0.2` for `upward`), after rounding up, so the upper bound is reachable:

| Failed attempt | Nominal `N` | `upward` | `equal` | `full` |
|----------------|-------------|----------|---------|--------|
| 1 | 30 s | 30–36 s | 15–30 s | 0–30 s |
| 2 | 60 s | 60–72 s | 30–60 s | 0–60 s |
| 3 | 120 s | 120–144 s | 60–120 s | 0–120 s |
| 4 | 240 s | 240–288 s | 120–240 s | 0–240 s |
| 5+ | 300 s (capped) | 300 s | 150–300 s | 0–300 s |

Use `equal` against rate limits (HTTP 429), because it spreads the retries more. Use `upward` when no retry must happen before the nominal delay.

```js
get retryBackoff() {
	return { baseDelaySeconds: 30, maxDelaySeconds: 300, jitterMode: 'equal' };
}
```

#### Exact delay

If you already calculated the delay of a message, pass it with `delaySeconds`: `addFailedMessage(messageId, { delaySeconds })`. It replaces the formula and `minDelaySeconds`, has no jitter and is only capped by `maxDelaySeconds` (and never lower than `0`). A delay lower than `baseDelaySeconds` is applied as is, and `0` returns the message to the queue right away. If you need a minimum, use `minDelaySeconds` instead. If the same message is added more than once, the options of the last call are used.

```js
this.addFailedMessage(record.messageId, { delaySeconds: 600 });
```

#### Long waits (up to 12 hours)

`maxDelaySeconds` can be up to `43200` (12 hours) to wait and continue a process later. SQS counts the 12 hours since the message was received, not since the visibility change, and rejects a longer visibility. So each delay is also capped by the time that is left in that invocation: `43200 − 300 (maximum batching window of Lambda) − seconds elapsed since the start of the invocation − 30 (margin)`. In practice, the cap is about 11 h 54 min.

- If SQS rejects the change anyway (for example, an invocation delayed by throttling), the message is reported as failed, a warning is logged and the message returns with the visibility timeout of the queue. There are no retries.
- The `MessageRetentionPeriod` of the queue must cover the sum of the delays × `maxReceiveCount`. If it does not, SQS deletes the message before it reaches the DLQ.
- `ApproximateReceiveCount` keeps adding in every retry, so the message reaches the DLQ with `maxReceiveCount`.

#### RetryBackoff

The package exports `RetryBackoff` with the same calculation used by the handler, so a service can precalculate the delay (for example, to store the date of the next retry) and then pass it with `delaySeconds`:

```js
const { RetryBackoff } = require('@janiscommerce/sqs-consumer');

// RetryBackoff.getAttempt(record: SQSRecord): number
// RetryBackoff.getRetryDelaySeconds(attempt: number, config?: RetryBackoffConfig, minDelaySeconds?: number): number

const attempt = RetryBackoff.getAttempt(record);

const delaySeconds = RetryBackoff.getRetryDelaySeconds(attempt, { baseDelaySeconds: 300, maxDelaySeconds: 7200 });

await this.saveNextRetryDate(record, new Date(Date.now() + (delaySeconds * 1000)));

this.addFailedMessage(record.messageId, { delaySeconds });
```

- `getAttempt()` returns the `ApproximateReceiveCount` of the record. A missing or invalid count is `1`.
- `getRetryDelaySeconds()` accepts the same `config` as the getter and completes the missing fields with the defaults. It applies the jitter of the `jitterMode`, `minDelaySeconds` and the cap of `maxDelaySeconds`, but not a floor of `baseDelaySeconds` nor the cap of the invocation. Unlike the handler, it throws an `Error` with the reason if the config is invalid.

The backoff is applied at the end of the invocation, only to the messages reported with `addFailedMessage()`, and only if the consumer finished without throwing. The failed messages are always returned in `batchItemFailures`, even if their visibility could not be changed (a warning is logged). A summary of the backoff of each invocation is logged.

- **FIFO queues are not supported:** the visibility of their messages is not changed and a warning is logged once per container.
- **Invalid config:** an error is logged once per container and the backoff is disabled. A getter that throws is handled as an invalid config.
- **Getter evaluation:** the getter is evaluated without session, so it can not depend on the client. It is evaluated only once per container, the first time there are failed messages.
- **Access denied:** an error is logged once per container and the backoff is disabled in that container.

> **Warning**
>
> **Postpone with `addFailedMessage()` and return, do not throw.** If `processBatch()` or `processSingleRecord()` throws, the handler propagates the error and no backoff is applied. With an `IterativeSQSConsumer`, the `Promise.all` of the records rejects the whole batch: the records that succeeded are retried too, and the backoff of the records that already called `addFailedMessage()` is lost.
>
> This is the usual case when migrating a consumer that changes the visibility of its messages on its own. Before:
>
> ```js
> async processSingleRecord(record) {
> 	try {
> 		await this.process(record.body);
> 	} catch(error) {
> 		const delaySeconds = this.getDelaySeconds(error);
> 		await sqsClient.send(new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle: record.receiptHandle, VisibilityTimeout: delaySeconds }));
> 		throw error;
> 	}
> }
> ```
>
> After:
>
> ```js
> async processSingleRecord(record) {
> 	try {
> 		await this.process(record.body);
> 	} catch(error) {
> 		const delaySeconds = this.getDelaySeconds(error);
> 		this.addFailedMessage(record.messageId, { delaySeconds });
> 		return;
> 	}
> }
> ```

#### Permissions

The lambda needs the `sqs:ChangeMessageVisibility` permission on the queue it consumes. It is granted by default by `sls-helper-plugin-janis >= 11.7.0`. With an older version, add an `iamStatement` with that action.

## :zap: Usage with serverless (lambda)

This package also exports a `SQSHandler` to easily integrate with AWS Lambda.

Usage is as easy as it can be, just export the following in your lambda:

```js
module.exports.handler = (event, context) => SQSHandler.handle(MySQSConsumer, event, context);
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

module.exports.handler = (event, context) => SQSHandler.handle(MyBatchConsumer, event, context);
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

module.exports.handler = (event, context) => SQSHandler.handle(MyIterativeConsumer, event, context);
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

module.exports.handler = (event, context) => SQSHandler.handle(MyConsumer, event, context);
```

### Session injection

This package implements [API Session](https://www.npmjs.com/package/@janiscommerce/api-session). In order to associate a request to a session, the record should be contain the property `janis-client` in the `messageAttributes`.

In case the `messageAttribute` is set, you can access the session in your `Consumer` as `this.session`. Otherwise, `this.session` will be `undefined`.

Session details and customization details can be found in api-session README.
