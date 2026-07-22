import { PartialType } from '@nestjs/mapped-types';
import { CreateCoopDto } from './create-coop.dto';

export class UpdateCoopDto extends PartialType(CreateCoopDto) {}
