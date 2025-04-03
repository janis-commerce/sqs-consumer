'use strict';

const logger = require('lllog')();

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const SQSHandlerError = require('../sqs-handler-error');

module.exports = class S3Downloader {

	/**
	 * Downloads content from an S3 bucket using the provided bucket details and content path.
	 * @static
	 * @async
	 * @param {Object} contentS3Location - Configuration object for the S3 bucket.
	 * @param {string} contentS3Location.bucketName - S3 bucket name.
	 * @param {string} contentS3Location.region - AWS region where the bucket is located.
	 * @param {string} contentS3Location.path - S3 path to the content to download.
	 * @returns {Promise<string|null>} Resolves to the content as a string, or null if an error occurs.
	 */
	static async downloadFromBucket({ bucketName, region, path }) {

		try {

			const s3Client = new S3Client({ region });

			const { Body } = await s3Client.send(new GetObjectCommand({
				Bucket: bucketName,
				Key: path
			}));

			return await Body.transformToString();

		} catch(error) {
			logger.error(`Error downloading from bucket ${bucketName} in region ${region}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Downloads content from S3 by attempting to fetch from a specified bucket.
	 * @static
	 * @async
	 * @param {Object} contentS3Location - Object specifying the content's S3 location.
	 * @param {string} contentS3Location.bucketName - S3 bucket name.
	 * @param {string} contentS3Location.region - AWS region where the bucket is located.
	 * @param {string} contentS3Location.path - S3 path to the content to download.
	 * @returns {Promise<Object>} Resolves to the parsed JSON content from the S3 object.
	 * @throws {SQSHandlerError} If downloading from the bucket fails.
	 */
	static async downloadContentS3Location(contentS3Location) {

		const body = await this.downloadFromBucket(contentS3Location);

		if(body)
			return JSON.parse(body);

		throw new SQSHandlerError('Failed to download from bucket', SQSHandlerError.codes.S3_ERROR);
	}
};
