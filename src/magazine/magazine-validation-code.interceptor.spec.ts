import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { CreateReaderCommentDto } from './dto/create-reader-comment.dto';
import { CreateStorySubmissionDto } from './dto/create-story-submission.dto';
import { CreateWriterApplicationDto } from './dto/create-writer-application.dto';
import { SubmitPitchDto } from './dto/submit-pitch.dto';
import { MAGAZINE_ERROR_CODE } from './magazine-error-codes';
import {
  MagazineValidationCodeInterceptor,
  withValidationCodes,
} from './magazine-validation-code.interceptor';

/**
 * Runs `body` through the production global `ValidationPipe` for `metatype`
 * and returns what it throws, so the specs below see the exact 400 the
 * interceptor receives in a real request.
 */
async function validationFailure(
  metatype: new () => object,
  body: Record<string, unknown>,
): Promise<unknown> {
  const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
  return pipe.transform(body, { type: 'body', metatype }).then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
}

/** The body the client would receive once the interceptor has run. */
async function codedBody(
  metatype: new () => object,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rewritten = withValidationCodes(
    await validationFailure(metatype, body),
  );
  expect(rewritten).toBeInstanceOf(BadRequestException);
  return (rewritten as BadRequestException).getResponse() as Record<
    string,
    unknown
  >;
}

describe('MagazineValidationCodeInterceptor', () => {
  describe('CreateWriterApplicationDto', () => {
    it('codes an invalid sample link and keeps the English sentence', async () => {
      const body = await codedBody(CreateWriterApplicationDto, {
        sampleLink: 'not a url',
      });
      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        message: ['sampleLink must be a URL address'],
        code: MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_INVALID,
        codes: [MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_INVALID],
      });
    });

    it('codes each over-long field', async () => {
      const body = await codedBody(CreateWriterApplicationDto, {
        pitchNote: 'x'.repeat(2001),
        sampleText: 'x'.repeat(20001),
      });
      const expectedCodes = [
        MAGAZINE_ERROR_CODE.WRITER_APPLICATION_PITCH_NOTE_TOO_LONG,
        MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_TEXT_TOO_LONG,
      ];
      expect(body.message).toEqual(
        expect.arrayContaining([
          'pitchNote must be shorter than or equal to 2000 characters',
          'sampleText must be shorter than or equal to 20000 characters',
        ]),
      );
      expect(body.codes).toEqual(expect.arrayContaining(expectedCodes));
      expect(expectedCodes).toContain(body.code);
    });

    it('codes an over-long sample link', async () => {
      const body = await codedBody(CreateWriterApplicationDto, {
        sampleLink: `https://example.com/${'x'.repeat(2000)}`,
      });
      expect(body.codes).toContain(
        MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_TOO_LONG,
      );
    });

    it('codes a field that is not text', async () => {
      const body = await codedBody(CreateWriterApplicationDto, {
        sampleText: 42,
      });
      expect(body.codes).toContain(MAGAZINE_ERROR_CODE.MAGAZINE_FIELD_NOT_TEXT);
      expect(body.message).toContain('sampleText must be a string');
    });
  });

  describe('CreateStorySubmissionDto', () => {
    const validSubmission = {
      format: 'Personal essay',
      workingTitle: 'A title',
      pitch: 'A pitch.',
    };

    it('codes an over-long working title', async () => {
      const body = await codedBody(CreateStorySubmissionDto, {
        ...validSubmission,
        workingTitle: 'x'.repeat(201),
      });
      expect(body.code).toBe(
        MAGAZINE_ERROR_CODE.STORY_SUBMISSION_WORKING_TITLE_TOO_LONG,
      );
      expect(body.message).toEqual([
        'workingTitle must be shorter than or equal to 200 characters',
      ]);
    });

    it('codes an empty pitch', async () => {
      const body = await codedBody(CreateStorySubmissionDto, {
        ...validSubmission,
        pitch: '',
      });
      expect(body.code).toBe(
        MAGAZINE_ERROR_CODE.STORY_SUBMISSION_PITCH_REQUIRED,
      );
    });

    it('codes a cover that is not an uploaded image', async () => {
      const body = await codedBody(CreateStorySubmissionDto, {
        ...validSubmission,
        coverImageKey: 'javascript:alert(1)',
      });
      expect(body.code).toBe(
        MAGAZINE_ERROR_CODE.STORY_SUBMISSION_COVER_INVALID,
      );
      expect(body.message).toEqual([
        'coverImageKey must be an uploaded image key or an https:// URL on a trusted image host',
      ]);
    });
  });

  describe('CreateReaderCommentDto', () => {
    it('codes an empty body', async () => {
      const body = await codedBody(CreateReaderCommentDto, { body: '' });
      expect(body.code).toBe(
        MAGAZINE_ERROR_CODE.MAGAZINE_READER_COMMENT_BODY_REQUIRED,
      );
    });

    it('codes a parent id that is not a UUID', async () => {
      const body = await codedBody(CreateReaderCommentDto, {
        body: 'Lovely piece.',
        parentId: 'nope',
      });
      expect(body.code).toBe(
        MAGAZINE_ERROR_CODE.MAGAZINE_READER_COMMENT_PARENT_ID_INVALID,
      );
      expect(body.message).toEqual(['parentId must be a UUID']);
    });
  });

  describe('SubmitPitchDto', () => {
    it('codes too many tags', async () => {
      const body = await codedBody(SubmitPitchDto, {
        title: 'A pitch',
        note: 'Why now.',
        tags: Array.from({ length: 21 }, (_unused, position) => `t${position}`),
      });
      expect(body.code).toBe(MAGAZINE_ERROR_CODE.MAGAZINE_PITCH_TAGS_TOO_MANY);
      expect(body.message).toEqual([
        'tags must contain no more than 20 elements',
      ]);
    });
  });

  describe('withValidationCodes', () => {
    it('leaves an uncoded validation 400 untouched', async () => {
      const original = new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['property extra should not exist'],
      });
      expect(withValidationCodes(original)).toBe(original);
    });

    it('leaves a service refusal untouched', () => {
      const original = new NotFoundException({
        code: MAGAZINE_ERROR_CODE.MAGAZINE_ISSUE_NOT_FOUND,
        message: 'Issue not found',
      });
      expect(withValidationCodes(original)).toBe(original);
    });

    it('rewrites the error a handler chain throws', async () => {
      const interceptor = new MagazineValidationCodeInterceptor();
      const failure = await validationFailure(CreateWriterApplicationDto, {
        sampleLink: 'not a url',
      });
      const handler: CallHandler = {
        handle: () => throwError(() => failure),
      };
      const rejection = await lastValueFrom(
        interceptor.intercept({} as ExecutionContext, handler),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toMatchObject({
        constructor: BadRequestException,
        response: {
          code: MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_INVALID,
        },
      });
    });
  });
});
