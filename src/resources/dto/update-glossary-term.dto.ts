import { PartialType } from '@nestjs/swagger';
import { CreateGlossaryTermDto } from './create-glossary-term.dto';

export class UpdateGlossaryTermDto extends PartialType(CreateGlossaryTermDto) {}
