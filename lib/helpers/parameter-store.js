/* eslint-disable import/no-extraneous-dependencies */

'use strict';

const { RAMClient, ListResourcesCommand } = require('@aws-sdk/client-ram');
const { SSMClient, GetParameterCommand } = require('@aws-sdk/client-ssm');

const memoize = require('micro-memoize');

const SQSHandlerError = require('../sqs-handler-error');

/**
 * @typedef {Object} S3BucketConfig
 * @property {string} bucketName - The name of the S3 bucket.
 * @property {string} roleArn - The ARN of the IAM role associated with the bucket.
 * @property {string} region - The AWS region where the bucket is located.
 * @property {boolean} [default] - Indicates if this bucket is the default (optional).
 */

class ParameterStore {

	/**
	 * @private
	 * @static
	 */
	static get parameterName() {
		return '/shared/internal-storage';
	}

	static clearCache() {
		ParameterStore.getParameterValue.cache.keys.length = [];
		ParameterStore.getParameterValue.cache.values.length = [];
		ParameterStore.getParameterArnFromRAM.cache.keys.length = [];
		ParameterStore.getParameterArnFromRAM.cache.values.length = [];
	}

	/**
	 * Retrieves a parameter value from AWS SSM Parameter Store using its ARN.
	 * This method first obtains the parameter's ARN by calling `getParameterArnFromRAM`, then fetches
	 * the parameter value from SSM Parameter Store, decrypting it if it is a secure string.
	 *
	 * @static
	 * @async
	 * @returns {Promise<Array<S3BucketConfig>|undefined>} A parsed JSON array of S3 bucket configurations,
	 *   each containing `bucketName` (string), `roleArn` (string), `region` (string), and an optional
	 *   `default` (boolean) flag. Returns `undefined` if the parameter retrieval fails or no ARN is found.
	 * @throws {SqsHandlerError} If `getParameterArnFromRAM` fails or the SSM command encounters an error,
	 *   with a message detailing the failure and an error code of `SqsHandlerError.codes.SSM_ERROR`.
	 */
	static async getParameterValue() {

		const parameterArn = await this.getParameterArnFromRAM();

		try {

			const ssmClient = new SSMClient();

			const params = {
				Name: parameterArn,
				WithDecryption: true
			};

			const response = await ssmClient.send(new GetParameterCommand(params));

			return JSON.parse(response.Parameter.Value);

		} catch(error) {
			throw new SQSHandlerError(`Unable to get parameter with arn ${parameterArn} - ${error.message}`, SQSHandlerError.codes.SSM_ERROR);
		}
	}

	/**
	 * Retrieves the ARN of a specific parameter from AWS Resource Access Manager (RAM).
	 * Filters shared resources owned by 'OTHER-ACCOUNTS' to find an ARN containing the specified parameter name.
	 *
	 * @static
	 * @async
	 * @returns {Promise<string>} The ARN of the first resource matching the parameter name. Logs an error and returns `undefined` if no matching resources are found.
	 * @throws {SqsHandlerError} If listing RAM resources fails, with a message detailing the error and an error code of `SqsHandlerError.codes.RAM_ERROR`.
	 */
	static async getParameterArnFromRAM() {

		try {

			const command = new ListResourcesCommand({ resourceOwner: 'OTHER-ACCOUNTS' });

			const ramClient = new RAMClient({ region: 'us-east-1' });

			const response = await ramClient.send(command);

			const filteredResources = response.resources.filter(
				resource => resource.arn.includes(this.parameterName)
			);

			if(!filteredResources.length)
				throw new Error(`Unable to find resources with parameter ${this.parameterName} in the ARN`);

			return filteredResources[0].arn;

		} catch(error) {
			throw new SQSHandlerError(`Resource Access Manager Error: ${error.message}`, SQSHandlerError.codes.RAM_ERROR);
		}
	}

}

ParameterStore.getParameterValue = memoize(ParameterStore.getParameterValue, { isPromise: true });
ParameterStore.getParameterArnFromRAM = memoize(ParameterStore.getParameterArnFromRAM, { isPromise: true });

module.exports = ParameterStore;
