'use strict';

class SQSHandlerError extends Error {

	static get codes() {
		return {
			S3_ERROR: 'S3_ERROR'
		};
	}

	constructor(err, code) {
		super(err);
		this.message = err.message || err;
		this.code = code;
		this.name = 'SqsHandlerError';
	}
}

module.exports = SQSHandlerError;
