import { PartialType } from '@nestjs/mapped-types';
import { CreateModResponseTemplateDto } from './create-mod-response-template.dto';

// Every field optional. Omitted fields are left untouched; an explicit `null`
// on `reasonCode` / `actionCode` widens the template back to "fits any".
export class UpdateModResponseTemplateDto extends PartialType(
  CreateModResponseTemplateDto,
) {}
