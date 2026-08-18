import { Type } from 'class-transformer';
import {
  IsLatitude,
  IsLongitude,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * `GET /listings/similar` query — the wizard's live dedupe check (item #5).
 * `name` is always sent; `lat`/`lng` are sent once the address has a resolved
 * pin so the server can also match nearby listings regardless of name. The two
 * coordinate fields are validated together in the service (both or neither).
 */
export class SimilarListingsQuery {
  @IsString() @IsNotEmpty() @MaxLength(200) name!: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  lat?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  lng?: number;

  /** The listing being edited, so it doesn't surface as a "duplicate" of
   *  itself when the wizard's dedupe check re-runs against its own name. */
  @IsOptional()
  @IsString()
  @MaxLength(50)
  excludeRef?: string;
}
