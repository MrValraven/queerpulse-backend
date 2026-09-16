// The reporting tests assert whether Sentry was called, which a bare import
// cannot show without a spy. Same module mock `chat.gateway.spec.ts` uses.
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));

import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import * as Sentry from '@sentry/node';
import { ChatWsErrorCode, ChatWsErrorFrame, ChatWsException } from './ws-error';
import { WsAllExceptionsFilter } from './ws-exception.filter';

const mockedCaptureException = Sentry.captureException as jest.Mock;

describe('WsAllExceptionsFilter', () => {
  const originalSentryDsn = process.env.SENTRY_DSN;
  let filter: WsAllExceptionsFilter;
  let loggerError: jest.SpyInstance;
  let loggerDebug: jest.SpyInstance;

  /** Runs the filter against a fake socket and returns the one frame it sent. */
  function emittedFrame(exception: unknown): ChatWsErrorFrame {
    const emit = jest.fn();
    const host = {
      switchToWs: () => ({ getClient: () => ({ emit }) }),
    } as unknown as ArgumentsHost;

    filter.catch(exception, host);

    expect(emit).toHaveBeenCalledTimes(1);
    const [eventName, frame] = emit.mock.calls[0] as [string, ChatWsErrorFrame];
    expect(eventName).toBe('exception');
    return frame;
  }

  beforeEach(() => {
    filter = new WsAllExceptionsFilter();
    loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    loggerDebug = jest
      .spyOn(Logger.prototype, 'debug')
      .mockImplementation(() => undefined);
    mockedCaptureException.mockClear();
    process.env.SENTRY_DSN = 'https://public@sentry.invalid/1';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalSentryDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalSentryDsn;
    }
  });

  describe('frame shape', () => {
    it.each<ChatWsErrorCode>([
      'RATE_LIMITED',
      'TOKEN_EXPIRED',
      'SESSION_REVOKED',
      'FORBIDDEN',
    ])(
      'passes a deliberate ChatWsException through with its own %s code',
      (code) => {
        const frame = emittedFrame(new ChatWsException(code, 'Refused'));

        expect(frame).toStrictEqual({
          status: 'error',
          code,
          message: 'Refused',
        });
      },
    );

    it("keeps a ChatWsException's own statusCode when it carries one", () => {
      const frame = emittedFrame(
        new ChatWsException('PLATFORM_LOCKED', 'Back soon', 423),
      );

      expect(frame).toStrictEqual({
        status: 'error',
        code: 'PLATFORM_LOCKED',
        message: 'Back soon',
        statusCode: 423,
      });
    });

    it.each<[string, HttpException, ChatWsErrorCode, number]>([
      ['401', new UnauthorizedException(), 'UNAUTHORIZED', 401],
      ['403', new ForbiddenException(), 'FORBIDDEN', 403],
      ['404', new NotFoundException(), 'NOT_FOUND', 404],
      ['429', new HttpException('Too many requests', 429), 'RATE_LIMITED', 429],
      ['400', new BadRequestException(), 'BAD_REQUEST', 400],
      ['409', new ConflictException(), 'BAD_REQUEST', 409],
      ['422', new HttpException('Unprocessable', 422), 'BAD_REQUEST', 422],
      ['500', new InternalServerErrorException(), 'SERVER_ERROR', 500],
      ['503', new HttpException('Unavailable', 503), 'SERVER_ERROR', 503],
    ])(
      'maps an HttpException with status %s to its coded frame',
      (_label, exception, code, statusCode) => {
        const frame = emittedFrame(exception);

        expect(frame.status).toBe('error');
        expect(frame.code).toBe(code);
        expect(frame.statusCode).toBe(statusCode);
      },
    );

    it("carries an HttpException's string response as the message", () => {
      const frame = emittedFrame(
        new HttpException('Conversation not found', 404),
      );

      expect(frame).toStrictEqual({
        status: 'error',
        code: 'NOT_FOUND',
        message: 'Conversation not found',
        statusCode: 404,
      });
    });

    it('lifts the message out of an object response, validation arrays included', () => {
      const frame = emittedFrame(
        new BadRequestException(['conversationId must be a UUID']),
      );

      expect(frame).toStrictEqual({
        status: 'error',
        code: 'BAD_REQUEST',
        message: ['conversationId must be a UUID'],
        statusCode: 400,
      });
    });

    it("maps a plain WsException (the ValidationPipe's exceptionFactory) to BAD_REQUEST without a statusCode", () => {
      const validationErrors = [
        { property: 'conversationId', constraints: { isUuid: 'bad' } },
      ];

      const frame = emittedFrame(new WsException(validationErrors));

      expect(frame).toStrictEqual({
        status: 'error',
        code: 'BAD_REQUEST',
        message: validationErrors,
      });
    });

    it("never leaks an unclassified error's message or stack to the client", () => {
      const internalError = new Error(
        'connect ECONNREFUSED 10.0.0.12:5432 password=hunter2',
      );

      const frame = emittedFrame(internalError);

      expect(frame).toStrictEqual({
        status: 'error',
        code: 'SERVER_ERROR',
        message: 'Internal server error',
      });
      const serialised = JSON.stringify(frame);
      expect(serialised).not.toContain('ECONNREFUSED');
      expect(serialised).not.toContain('hunter2');
    });

    it('sends the same generic frame for a thrown value that is not an Error', () => {
      expect(emittedFrame('raw string failure')).toStrictEqual({
        status: 'error',
        code: 'SERVER_ERROR',
        message: 'Internal server error',
      });
    });
  });

  describe('reporting', () => {
    it('logs a deliberate refusal at debug level only and never reports it', () => {
      emittedFrame(new ChatWsException('RATE_LIMITED', 'Slow down'));
      emittedFrame(new ForbiddenException('Not yours'));
      emittedFrame(new WsException('malformed'));

      expect(loggerDebug).toHaveBeenCalledTimes(3);
      expect(loggerError).not.toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('logs an unclassified fault with its stack and reports it when Sentry is configured', () => {
      const internalError = new Error('database went away');

      emittedFrame(internalError);

      expect(loggerError).toHaveBeenCalledWith(internalError.stack);
      expect(mockedCaptureException).toHaveBeenCalledWith(internalError);
      expect(loggerDebug).not.toHaveBeenCalled();
    });

    it('reports a 5xx HttpException as a server fault', () => {
      const serverFault = new InternalServerErrorException();

      emittedFrame(serverFault);

      expect(loggerError).toHaveBeenCalled();
      expect(mockedCaptureException).toHaveBeenCalledWith(serverFault);
    });

    it('still logs a server fault, without calling Sentry, when no DSN is configured', () => {
      delete process.env.SENTRY_DSN;

      emittedFrame(new Error('database went away'));

      expect(loggerError).toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });
  });
});
