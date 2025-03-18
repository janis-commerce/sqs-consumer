'use strict';

class SQSHandlerError extends Error {

	static get codes() {
		return {
			ASSUME_ROLE_ERROR: 'ASSUME_ROLE_ERROR',
			RAM_ERROR: 'RAM_ERROR',
			SSM_ERROR: 'SSM_ERROR',
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
