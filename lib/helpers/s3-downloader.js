'use strict';

const logger = require('lllog')();

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const AssumeRole = require('./assume-role');

const SQSHandlerError = require('../sqs-handler-error');

const { streamToString } = require('../utils/stream-to-string');

module.exports = class S3Downloader {

	/**
	 * Downloads content from an S3 bucket using provided bucket details and a content path.
	 * @static
	 * @async
	 * @param {Object} bucket - The bucket configuration object.
	 * @param {string} bucket.bucketName - The name of the S3 bucket.
	 * @param {string} bucket.region - The AWS region where the bucket is located.
	 * @param {string} bucket.roleArn - The ARN of the IAM role to assume for accessing the bucket.
	 * @param {string} contentS3Path - The S3 key/path to the content to download.
	 * @returns {Promise<string|null>} A promise that resolves to the content as a string, or null if an error occurs.
	 */
	static async downloadFromBucket(bucket, contentS3Path) {

		try {

			const credentials = await AssumeRole.getCredentials(bucket.roleArn);

			const s3Client = new S3Client({ region: bucket.region, credentials });

			const { Body } = await s3Client.send(new GetObjectCommand({
				Bucket: bucket.bucketName,
				Key: contentS3Path
			}));

			return await streamToString(Body);

		} catch(error) {
			logger.error(`Error downloading from bucket ${bucket.bucketName} in region ${bucket.region}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Downloads content from S3 by attempting to fetch from a default bucket first, then a provisional bucket if the first fails.
	 * @static
	 * @async
	 * @param {Array<Object>} buckets - An array of two bucket configuration objects.
	 * @param {Object} buckets.0 - The default bucket configuration (first attempt).
	 * @param {Object} buckets.1 - The provisional bucket configuration (fallback attempt).
	 * @param {string} contentS3Path - The S3 key/path to the content to download.
	 * @returns {Promise<Object>} A promise that resolves to the parsed JSON content from the S3 object.
	 * @throws {SQSHandlerError} If downloading fails from both the default and provisional buckets.
	 */
	static async downloadContentS3Path(buckets, contentS3Path) {

		const [defaultBucket, provisionalBucket] = buckets;

		let body = await this.downloadFromBucket(defaultBucket, contentS3Path);

		if(body)
			return JSON.parse(body);

		body = await this.downloadFromBucket(provisionalBucket, contentS3Path);

		if(body)
			return JSON.parse(body);

		throw new SQSHandlerError('Failed to download from both default and provisional buckets', SQSHandlerError.codes.S3_ERROR);
	}
};
