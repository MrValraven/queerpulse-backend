import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

const trimmed = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Body for `POST /admin/ambassadors/:id/revoke`. The reason is internal to staff. */
export class RevokeAmbassadorDto {
  @IsString()
  @Transform(trimmed)
  @Length(3, 500)
  reason!: string;
}
