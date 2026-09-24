import { PartialType } from '@nestjs/mapped-types';
import { CreateEmailTemplateDto } from './create-email-template.dto';

// Every field optional; omitted fields are left untouched. `locales`, when
// present, replaces both languages at once.
export class UpdateEmailTemplateDto extends PartialType(
  CreateEmailTemplateDto,
) {}
