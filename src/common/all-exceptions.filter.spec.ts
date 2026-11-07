// The quiet-path tests assert whether Sentry was called, which a bare import
// cannot show without a spy. Same module mock `ws-exception.filter.spec.ts` uses.
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import {
  ArgumentsHost,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { codedErrorBody } from './coded-error';

const mockedCaptureException = Sentry.captureException as jest.Mock;

describe('AllExceptionsFilter', () => {
  const originalSentryDsn = process.env.SENTRY_DSN;
  let filter: AllExceptionsFilter;
  let loggerError: jest.SpyInstance;

  /** Runs the filter against a fake HTTP response and returns what it sent. */
  function sentResponse(exception: unknown): {
    status: number;
    body: Record<string, unknown>;
  } {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      getType: () => 'http',
      switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledTimes(1);
    return {
      status: (status.mock.calls as [number][])[0]![0],
      body: (json.mock.calls as [Record<string, unknown>][])[0]![0],
    };
  }

  /** What body-parser throws for an oversized body (an http-errors error). */
  function bodyParserTooLargeError(): Error {
    return Object.assign(new Error('request entity too large'), {
      status: 413,
      statusCode: 413,
      type: 'entity.too.large',
      expose: true,
    });
  }

  beforeEach(() => {
    process.env.SENTRY_DSN = 'https://public@example.ingest.sentry.io/1';
    filter = new AllExceptionsFilter({} as never);
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    mockedCaptureException.mockClear();
    // String-body and non-HTTP errors defer to Nest's default handling, which
    // needs a real HTTP adapter; the spec only cares that the filter reached it.
    jest
      .spyOn(BaseExceptionFilter.prototype, 'catch')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  describe('a body-parser 413', () => {
    it('answers 413 with the PAYLOAD_TOO_LARGE code and the original message', () => {
      const { status, body } = sentResponse(bodyParserTooLargeError());

      expect(status).toBe(413);
      expect(body).toEqual({
        statusCode: 413,
        error: 'Payload Too Large',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'request entity too large',
      });
    });

    it('is not logged at error level and not sent to Sentry', () => {
      sentResponse(bodyParserTooLargeError());

      expect(loggerError).not.toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('is recognised by status alone, without the type field', () => {
      const { status, body } = sentResponse(
        Object.assign(new Error('too big'), { status: 413 }),
      );

      expect(status).toBe(413);
      expect(body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(body.message).toBe('too big');
    });

    it('is recognised by the entity.too.large type alone', () => {
      const { status, body } = sentResponse(
        Object.assign(new Error('too big'), { type: 'entity.too.large' }),
      );

      expect(status).toBe(413);
      expect(body.code).toBe('PAYLOAD_TOO_LARGE');
    });
  });

  it('still logs and reports a genuine unhandled error', () => {
    const host = { getType: () => 'http' } as unknown as ArgumentsHost;

    filter.catch(new Error('database exploded'), host);

    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
  });

  it('still logs and reports a 5xx HttpException', () => {
    const { status } = sentResponse(new InternalServerErrorException('boom'));

    expect(status).toBe(500);
    expect(loggerError).toHaveBeenCalledTimes(1);
    expect(mockedCaptureException).toHaveBeenCalledTimes(1);
  });

  it('keeps a coded 403 quiet and passes its code through', () => {
    const { status, body } = sentResponse(
      new ForbiddenException(codedErrorBody('CSRF_REJECTED', 'nope')),
    );

    expect(status).toBe(403);
    expect(body).toEqual({
      statusCode: 403,
      error: 'Forbidden',
      code: 'CSRF_REJECTED',
      message: 'nope',
    });
    expect(loggerError).not.toHaveBeenCalled();
    expect(mockedCaptureException).not.toHaveBeenCalled();
  });
});
