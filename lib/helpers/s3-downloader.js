'use strict';

const logger = require('lllog')();

const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');

const AssumeRole = require('./assume-role');

const SQSHandlerError = require('../sqs-handler-error');

module.exports = class S3Downloader {

	static async downloadFromBucket(bucket, s3ContentPath) {

		try {

			const credentials = await AssumeRole.getCredentials(bucket.roleArn);

			const s3Client = new S3Client({ region: bucket.region, credentials });

			const { Body } = await s3Client.send(new GetObjectCommand({
				Bucket: bucket.bucketName,
				Key: s3ContentPath
			}));

			return Body;

		} catch(error) {
			logger.error(`Error downloading from bucket ${bucket.bucketName} in region ${bucket.region}: ${error.message}`);
		}
	}

	static async downloadS3ContentPath(buckets, s3ContentPath) {

		const [defaultBucket, provisionalBucket] = buckets;

		const body = await this.downloadFromBucket(defaultBucket, s3ContentPath) || await this.downloadFromBucket(provisionalBucket, s3ContentPath);

		if(body)
			return body;

		throw new SQSHandlerError('Failed to download from both default and provisional buckets', SQSHandlerError.codes.S3_ERROR);
	}

};
