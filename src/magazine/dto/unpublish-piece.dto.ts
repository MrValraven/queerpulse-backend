import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/** The stages an unpublished piece can be sent back to. */
export const UNPUBLISH_TARGET_STAGES = ['drafting', 'in_review'] as const;

export type UnpublishTargetStage = (typeof UNPUBLISH_TARGET_STAGES)[number];

/**
 * `POST /magazine/admin/pieces/:id/unpublish` body. The whole body is
 * optional so existing callers that send nothing keep today's behaviour: a
 * published piece lands at `ready`.
 *
 * `stage` sends the piece back to the writer (`drafting`) or to the editor
 * (`in_review`) instead. `published` and every other stage are refused here
 * with a 400, because taking a piece down must never double as a way to jump
 * it to an arbitrary point in the pipeline.
 */
export class UnpublishPieceDto {
  @ApiPropertyOptional({
    enum: UNPUBLISH_TARGET_STAGES,
    description:
      'Where the piece lands once it is off the live site. Omitted: a published piece goes to `ready`.',
  })
  @IsOptional()
  @IsIn(UNPUBLISH_TARGET_STAGES)
  stage?: UnpublishTargetStage;
}
