import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import {
  codedValidationMessage,
  MAGAZINE_ERROR_CODE,
  NOT_TEXT_VALIDATION_MESSAGE,
  tooLongValidationMessage,
} from '../magazine-error-codes';

/**
 * Body of `POST /magazine/writer-applications`.
 *
 * Every constraint carries a magazine code through `codedValidationMessage`,
 * and `MagazineValidationCodeInterceptor` (on `WriterApplicationsController`)
 * surfaces it as `code` (first failure) and `codes` (all failures) in the 400
 * body, beside the unchanged English sentences in `message`.
 */
export class CreateWriterApplicationDto {
  @IsOptional()
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MaxLength(2000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.WRITER_APPLICATION_PITCH_NOTE_TOO_LONG,
    ),
  })
  pitchNote?: string;

  @IsOptional()
  @IsString({ message: NOT_TEXT_VALIDATION_MESSAGE })
  @MaxLength(20000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_TEXT_TOO_LONG,
    ),
  })
  sampleText?: string;

  @IsOptional()
  @IsUrl(
    {},
    {
      message: codedValidationMessage(
        MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_INVALID,
        '$property must be a URL address',
      ),
    },
  )
  @MaxLength(2000, {
    message: tooLongValidationMessage(
      MAGAZINE_ERROR_CODE.WRITER_APPLICATION_SAMPLE_LINK_TOO_LONG,
    ),
  })
  sampleLink?: string;
}
