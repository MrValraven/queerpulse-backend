import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { INQUIRY_KINDS, InquiryKind } from '../entities/inquiry.entity';

/**
 * Body for `POST /inquiries` — a public marketing-form submission. Validated
 * with `whitelist`/`forbidNonWhitelisted` (global pipe), so unknown fields are
 * rejected. `kind` decides which form it came from (or, for
 * `listing_correction`, which Contact topic); `orgName`/`subject` are
 * optional because the Contact form has no organisation and either form may
 * omit a topic. Lengths are capped to keep a public, unauthenticated endpoint
 * from accepting unbounded text.
 */
export class CreateInquiryDto {
  @IsIn(INQUIRY_KINDS)
  kind!: InquiryKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  subject?: string;

  /**
   * PRD-452. The Contact form's topic id (`safety`, `press`, ...), sent beside
   * the translated `subject` label so the server can read it in any locale.
   * Free text by design: the topic list is the frontend's, and a topic added
   * there must keep the form working. Only the ids in
   * `PRIORITY_INQUIRY_TOPICS` change anything; it is not stored.
   */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  topic?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  orgName?: string;

  /**
   * PRD-434. The directory listing a `listing_correction` is about, as the
   * reference the "Suggest a correction" link carried (`QPL-2026-0007`).
   * Same loose pattern as the frontend's `listingRefFromParam`: letters,
   * digits and hyphens, so a future prefix still passes. Stored only on a
   * `listing_correction`; any other kind drops it.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{3,40}$/)
  listingRef?: string;
}
