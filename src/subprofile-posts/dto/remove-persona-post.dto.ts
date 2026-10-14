import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PERSONA_POST_REMOVAL_REASON_MAX } from '../persona-post.constants';

/** `POST /admin/persona-posts/:postId/remove`. Kept in the audit trail;
 *  `reportId` links the removal to the report it answers. */
export class RemovePersonaPostDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(PERSONA_POST_REMOVAL_REASON_MAX)
  reason!: string;

  @IsOptional()
  @IsUUID()
  reportId?: string;
}
