'use strict';

const logger = require('lllog')();

module.exports = class LogTransport {

	constructor(traceId) {
		this.traceId = traceId;
	}

	get prefix() {
		return `[${this.traceId}]`;
	}

	debug(...args) {
		logger.debug(this.prefix, ...args);
	}

	info(...args) {
		logger.info(this.prefix, ...args);
	}

	warn(...args) {
		logger.warn(this.prefix, ...args);
	}

	error(...args) {
		logger.error(this.prefix, ...args);
	}

	fatal(...args) {
		logger.fatal(this.prefix, ...args);
	}

};
