import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/**
 * `DELETE /admin/housing-groups/:id` body (ENG-602).
 *
 * Deleting a group hard-deletes every listing and join request filed under it,
 * so the staff member says why. The reason travels into the audit note beside
 * the cascade counts, which is the only record left once the rows are gone.
 */
export class DeleteHousingGroupDto {
  @IsString()
  @Transform(trimmed)
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
