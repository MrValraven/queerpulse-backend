import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateTitleDto } from './create-title.dto';

export class UpdateTitleDto extends PartialType(CreateTitleDto) {
  // true → publish (requires status 'ready'); false → unpublish.
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}
