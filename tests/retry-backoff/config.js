'use strict';

const assert = require('assert');

const RetryBackoffConfig = require('../../lib/retry-backoff/config');

describe('RetryBackoffConfig', () => {

	const defaults = { baseDelaySeconds: 60, maxDelaySeconds: 900, jitterRatio: 0.2 };

	describe('normalize', () => {

		it('Should apply the defaults when the config is empty', () => {

			assert.deepStrictEqual(RetryBackoffConfig.normalize({}), { valid: true, config: defaults });
		});

		it('Should apply the defaults when the config is true', () => {

			assert.deepStrictEqual(RetryBackoffConfig.normalize(true), { valid: true, config: defaults });
		});

		[undefined, null, false].forEach(input => {

			it(`Should return valid and disabled when the config is ${input}`, () => {
				assert.deepStrictEqual(RetryBackoffConfig.normalize(input), { valid: true, disabled: true });
			});
		});

		it('Should keep the provided values and default the missing ones', () => {

			assert.deepStrictEqual(RetryBackoffConfig.normalize({ baseDelaySeconds: 10, jitterRatio: 0 }), {
				valid: true,
				config: { baseDelaySeconds: 10, maxDelaySeconds: 900, jitterRatio: 0 }
			});
		});

		it('Should ignore unknown fields', () => {

			assert.deepStrictEqual(RetryBackoffConfig.normalize({ foo: 'bar' }), { valid: true, config: defaults });
		});

		it('Should accept the limits', () => {

			assert.strictEqual(RetryBackoffConfig.normalize({ baseDelaySeconds: 43200, maxDelaySeconds: 43200, jitterRatio: 0.99 }).valid, true);
		});

		it('Should not mutate the defaults', () => {

			RetryBackoffConfig.normalize({ baseDelaySeconds: 10 });

			assert.deepStrictEqual(RetryBackoffConfig.defaults, defaults);
		});

		[
			['not an object', 'foo', 'retryBackoff must be an object'],
			['an array', [], 'retryBackoff must be an object'],
			['non numeric base', { baseDelaySeconds: '60' }, 'baseDelaySeconds must be a finite number'],
			['null base', { baseDelaySeconds: null }, 'baseDelaySeconds must be a finite number'],
			['non finite max', { maxDelaySeconds: Infinity }, 'maxDelaySeconds must be a finite number'],
			['NaN jitter', { jitterRatio: NaN }, 'jitterRatio must be a finite number'],
			['zero base', { baseDelaySeconds: 0 }, 'baseDelaySeconds must be greater than 0'],
			['negative base', { baseDelaySeconds: -1 }, 'baseDelaySeconds must be greater than 0'],
			['base greater than max', { baseDelaySeconds: 1000 }, 'baseDelaySeconds must not be greater than maxDelaySeconds'],
			['max greater than 43200', { maxDelaySeconds: 43201 }, 'maxDelaySeconds must not be greater than 43200'],
			['negative jitter', { jitterRatio: -0.1 }, 'jitterRatio must be in the range [0, 1)'],
			['jitter of 1', { jitterRatio: 1 }, 'jitterRatio must be in the range [0, 1)']
		].forEach(([title, input, reason]) => {

			it(`Should return invalid with the reason when the config has ${title}`, () => {
				assert.deepStrictEqual(RetryBackoffConfig.normalize(input), { valid: false, reason });
			});
		});
	});
});
