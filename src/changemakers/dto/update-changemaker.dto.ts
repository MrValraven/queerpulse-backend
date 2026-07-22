import { PartialType } from '@nestjs/mapped-types';
import { CreateChangemakerDto } from './create-changemaker.dto';

export class UpdateChangemakerDto extends PartialType(CreateChangemakerDto) {}
