# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.1] - 2024-06-19
### Fixed
- Calling `Log.start()` when `handle()` is called to ensure end Trace Layer Extension
- Emit `janiscommerce.ended` when record/s are invalid by struct

## [0.4.0] - 2023-07-08
### Added
- Partial failure reporting feature

## [0.3.0] - 2022-12-21
### Added
- After each execution will emit the event `janiscommerce.ended` using `@janiscommerce/events`

## [0.2.0] - 2021-07-23
### Added
- Support for `struct` validation
- Support for `session` via SQS Message Attributes

## [0.1.1] - 2021-02-26
### Fixed
- SQS Event struct is now a partial, including eventSourceARN and receiptHandle
- Typo in README

## [0.1.0] - 2021-02-26
### Added
- IterativeSQSConsumer, BatchSQSConsumer, SQSConsumer and SQSHandler
- Package documentation
- Package types
