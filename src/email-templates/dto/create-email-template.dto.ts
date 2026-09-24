import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  EMAIL_TEMPLATE_PURPOSE_CODES,
  EmailTemplatePurpose,
} from '../email-template-purposes';

// `POST /admin/email-templates` body. Mirrors `EmailTemplateWriteBody` in
// `queerpulse/src/features/admin/emailTemplates/emailTemplate.types.ts`.
// `locales` is only shape-checked here; `validateEmailTemplateLocales` does the
// real work in the service, where the purpose is known.
export class CreateEmailTemplateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  @IsIn(EMAIL_TEMPLATE_PURPOSE_CODES)
  purpose!: EmailTemplatePurpose;

  @IsObject()
  locales!: Record<string, unknown>;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
