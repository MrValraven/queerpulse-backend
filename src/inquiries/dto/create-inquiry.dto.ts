import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { INQUIRY_KINDS, InquiryKind } from '../entities/inquiry.entity';

/**
 * Body for `POST /inquiries` — a public marketing-form submission. Validated
 * with `whitelist`/`forbidNonWhitelisted` (global pipe), so unknown fields are
 * rejected. `kind` decides which form it came from; `orgName`/`subject` are
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
}
