import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** The longest reason staff may give for ending or deleting a reported game. */
export const QUIZSHOW_STAFF_REASON_MAX = 500;

/**
 * `POST /admin/quizshow/sessions/:sessionId/end` and
 * `DELETE /admin/quizshow/sessions/:sessionId/game` body. The reason goes to
 * the moderation audit trail; `reportId` links the action to the report it
 * answers.
 */
export class QuizshowStaffActionDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(QUIZSHOW_STAFF_REASON_MAX)
  reason!: string;

  @IsOptional()
  @IsUUID()
  reportId?: string;
}
