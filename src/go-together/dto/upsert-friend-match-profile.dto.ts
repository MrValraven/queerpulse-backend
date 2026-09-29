import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsObject } from 'class-validator';

/**
 * `answers` is only shape-checked here; `parseFriendMatchAnswers` is the real
 * gate because the payload is stored as jsonb and must match the catalog ids.
 */
export class UpsertFriendMatchProfileDto {
  @ApiProperty({ description: 'Questionnaire answers keyed by catalog id.' })
  @IsObject()
  answers!: Record<string, unknown>;

  @ApiProperty({
    description:
      'Explicit consent to process these answers for matching (GDPR Art. 9).',
  })
  @IsBoolean()
  consent!: boolean;
}
