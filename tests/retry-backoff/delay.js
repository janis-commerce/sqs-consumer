'use strict';

const assert = require('assert');
const sinon = require('sinon');

const RetryDelay = require('../../lib/retry-backoff/delay');

describe('RetryDelay', () => {

	const config = { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2 };

	const noJitterConfig = { ...config, jitterRatio: 0 };

	afterEach(() => {
		sinon.restore();
	});

	describe('getAttempt', () => {

		it('Should return the ApproximateReceiveCount as number', () => {
			assert.strictEqual(RetryDelay.getAttempt({ attributes: { ApproximateReceiveCount: '3' } }), 3);
		});

		[undefined, null, {}, { attributes: {} }, { attributes: { ApproximateReceiveCount: 'foo' } },
			{ attributes: { ApproximateReceiveCount: '0' } }, { attributes: { ApproximateReceiveCount: '-2' } }
		].forEach(record => {

			it(`Should return 1 for ${JSON.stringify(record)}`, () => {
				assert.strictEqual(RetryDelay.getAttempt(record), 1);
			});
		});
	});

	describe('calculate', () => {

		it('Should grow exponentially without jitter', () => {

			assert.deepStrictEqual([1, 2, 3, 4].map(attempt => RetryDelay.calculate(attempt, noJitterConfig)), [60, 120, 240, 480]);
		});

		it('Should use the first attempt when the attempt is invalid', () => {

			assert.strictEqual(RetryDelay.calculate(0, noJitterConfig), 60);
			assert.strictEqual(RetryDelay.calculate('foo', noJitterConfig), 60);
		});

		it('Should apply the jitter only upwards', () => {

			sinon.stub(Math, 'random').returns(0);
			assert.strictEqual(RetryDelay.calculate(1, config), 60);

			Math.random.returns(0.5);
			assert.strictEqual(RetryDelay.calculate(1, config), 66);

			Math.random.returns(0.999);
			assert.strictEqual(RetryDelay.calculate(1, config), 72);
			assert.strictEqual(RetryDelay.calculate(2, config), 144);
		});

		it('Should round the result to an integer', () => {

			sinon.stub(Math, 'random').returns(0.123);
			assert.ok(Number.isInteger(RetryDelay.calculate(1, { ...config, baseDelaySeconds: 7 })));
		});

		it('Should raise the delay up to minDelaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 200 }), 200);
			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 30 }), 60);
		});

		it('Should ignore an invalid minDelaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 'foo' }), 60);
			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: NaN }), 60);
		});

		it('Should ceil a fractional minDelaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 100.2 }), 101);
		});

		it('Should cap the delay at maxDelaySeconds, also the floor', () => {

			assert.strictEqual(RetryDelay.calculate(10, noJitterConfig), 900);
			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 5000 }), 900);
		});

		it('Should cap at maxDelaySeconds after the jitter', () => {

			sinon.stub(Math, 'random').returns(0.999);
			assert.strictEqual(RetryDelay.calculate(5, config), 900);
		});

		it('Should return maxDelaySeconds when 2 ** n overflows', () => {

			assert.strictEqual(RetryDelay.calculate(5000, config), 900);
		});

		it('Should use the exact delaySeconds without jitter nor minDelaySeconds', () => {

			sinon.stub(Math, 'random').returns(0.999);
			assert.strictEqual(RetryDelay.calculate(3, config, { delaySeconds: 100, minDelaySeconds: 500 }), 100);
		});

		it('Should cap the exact delaySeconds at maxDelaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, config, { delaySeconds: 5000 }), 900);
		});

		it('Should ceil a fractional exact delaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, config, { delaySeconds: 100.2 }), 101);
		});

		[0, -5, 30].forEach(delaySeconds => {

			it(`Should raise an exact delaySeconds of ${delaySeconds} to baseDelaySeconds`, () => {

				assert.strictEqual(RetryDelay.calculate(1, config, { delaySeconds }), 60);
			});
		});

		it('Should raise a minDelaySeconds lower than baseDelaySeconds to baseDelaySeconds', () => {

			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { minDelaySeconds: 10 }), 60);
		});

		it('Should ignore an invalid delaySeconds and use the formula', () => {

			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { delaySeconds: 'foo' }), 60);
			assert.strictEqual(RetryDelay.calculate(1, noJitterConfig, { delaySeconds: NaN }), 60);
		});

		it('Should round up a fractional baseDelaySeconds', () => {

			sinon.stub(Math, 'random').returns(0);
			assert.strictEqual(RetryDelay.calculate(1, { baseDelaySeconds: 0.5, maxDelaySeconds: 10, jitterRatio: 0.5 }), 1);
		});

		it('Should cap at 43200 seconds', () => {

			const maxConfig = { baseDelaySeconds: 40000, maxDelaySeconds: 43200, jitterRatio: 0 };
			assert.strictEqual(RetryDelay.calculate(3, maxConfig), 43200);
			assert.strictEqual(RetryDelay.calculate(1, maxConfig, { delaySeconds: 50000 }), 43200);
		});
	});

	describe('limitToInvocation', () => {

		const maxConfig = { ...config, maxDelaySeconds: 43200 };

		const startedAt = 1700000000000;

		it('Should limit maxDelaySeconds to 43200 - 300 - 30 when the invocation just started', () => {

			sinon.useFakeTimers(startedAt);
			assert.deepStrictEqual(RetryDelay.limitToInvocation(maxConfig, startedAt), { ...maxConfig, maxDelaySeconds: 42870 });
		});

		it('Should discount the seconds elapsed since the start of the invocation', () => {

			sinon.useFakeTimers(startedAt + 600000);
			assert.deepStrictEqual(RetryDelay.limitToInvocation(maxConfig, startedAt), { ...maxConfig, maxDelaySeconds: 42270 });
		});

		it('Should keep maxDelaySeconds when it is lower than the limit of the invocation', () => {

			sinon.useFakeTimers(startedAt);
			assert.deepStrictEqual(RetryDelay.limitToInvocation(config, startedAt), config);
		});

		it('Should cap the exact delay of 43200 with the limit of the invocation', () => {

			sinon.useFakeTimers(startedAt + 600000);
			assert.strictEqual(RetryDelay.calculate(1, RetryDelay.limitToInvocation(maxConfig, startedAt), { delaySeconds: 43200 }), 42270);
		});

		it('Should not mutate the config', () => {

			sinon.useFakeTimers(startedAt);
			RetryDelay.limitToInvocation(maxConfig, startedAt);
			assert.strictEqual(maxConfig.maxDelaySeconds, 43200);
		});
	});
});
