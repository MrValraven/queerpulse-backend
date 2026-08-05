import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import type { InquiryKind } from '../entities/inquiry.entity';

/**
 * Body for `POST /inquiries` — a public marketing-form submission. Validated
 * with `whitelist`/`forbidNonWhitelisted` (global pipe), so unknown fields are
 * rejected. `kind` decides which form it came from; `orgName`/`subject` are
 * optional because the Contact form has no organisation and either form may
 * omit a topic. Lengths are capped to keep a public, unauthenticated endpoint
 * from accepting unbounded text.
 */
export class CreateInquiryDto {
  @IsIn(['contact', 'partner'])
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

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  body!: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  orgName?: string;
}
