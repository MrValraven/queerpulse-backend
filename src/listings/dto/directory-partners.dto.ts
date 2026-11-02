import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString, ValidateIf } from 'class-validator';

/** Body of `POST /admin/listings/partners`. */
export class CreateDirectoryPartnerDto {
  /** A listing id. The service owns the uuid check, so a malformed id answers
   *  `listing_not_found` and carries its reason code. */
  @ApiProperty({ description: 'Id of the listing to add as a partner.' })
  @IsString()
  listingId!: string;

  /** A one-line note. The service owns the length check, so a long note
   *  answers `note_too_long` and carries its reason code. */
  @ApiPropertyOptional({
    description: 'One-line note, up to 140 characters after trimming.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  note?: string | null;
}

/** Body of `PATCH /admin/listings/partners/:id`. */
export class UpdateDirectoryPartnerNoteDto {
  /** The new note, or `null` to clear it. The service owns the length check,
   *  so a long note answers `note_too_long` and carries its reason code. */
  @ApiProperty({
    description: 'One-line note, up to 140 characters, or null to clear it.',
    nullable: true,
    type: String,
  })
  @ValidateIf((_body: object, value: unknown) => value !== null)
  @IsString()
  note!: string | null;
}

/** Body of `PATCH /admin/listings/partners/order`. */
export class ReorderDirectoryPartnersDto {
  /** Every current pick id once, in the new order. The service owns the
   *  uuid and completeness checks, so a wrong set answers `order_mismatch`
   *  and carries its reason code. */
  @ApiProperty({
    description: 'Every current partner id once, in the new order.',
    type: [String],
  })
  @IsArray()
  @IsString({ each: true })
  ids!: string[];
}

/** Query of `GET /admin/listings/partners/search`. */
export class DirectoryPartnerSearchQuery {
  /** The search text. The service owns the length handling: it trims `q`,
   *  answers an empty list for a blank one and cuts a long one to 80
   *  characters, so no length rule can answer a generic 400. */
  @ApiPropertyOptional({ description: 'Search text for the picker.' })
  @IsOptional()
  @IsString()
  q?: string;
}
