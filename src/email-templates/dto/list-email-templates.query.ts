import { IsIn, IsOptional } from 'class-validator';
import {
  EMAIL_TEMPLATE_PURPOSE_CODES,
  EmailTemplatePurpose,
} from '../email-template-purposes';

export class ListEmailTemplatesQuery {
  @IsOptional()
  @IsIn(EMAIL_TEMPLATE_PURPOSE_CODES)
  purpose?: EmailTemplatePurpose;
}
