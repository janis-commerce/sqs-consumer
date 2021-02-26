'use strict';

const assert = require('assert');
const LogTransport = require('../lib/log-transport');

describe('Log Transport', () => {

	describe('prefix', () => {

		it('Should set the prefix in square brackets passed in the constructor', () => {
			const logger = new LogTransport('my-prefix');
			assert.strictEqual(logger.prefix, '[my-prefix]');
		});

	});

	describe('logging', () => {

		it('Should have a debug method', () => {
			const logger = new LogTransport('my-prefix');
			assert.doesNotThrow(() => logger.debug('test'));
		});

		it('Should have a info method', () => {
			const logger = new LogTransport('my-prefix');
			assert.doesNotThrow(() => logger.info('test'));
		});

		it('Should have a warn method', () => {
			const logger = new LogTransport('my-prefix');
			assert.doesNotThrow(() => logger.warn('test'));
		});

		it('Should have a error method', () => {
			const logger = new LogTransport('my-prefix');
			assert.doesNotThrow(() => logger.error('test'));
		});

		it('Should have a fatal method', () => {
			const logger = new LogTransport('my-prefix');
			assert.doesNotThrow(() => logger.fatal('test'));
		});

	});

});
