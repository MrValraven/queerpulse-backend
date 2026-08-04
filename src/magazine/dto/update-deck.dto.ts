import { PartialType } from '@nestjs/mapped-types';
import { IsBoolean, IsOptional } from 'class-validator';
import { CreateDeckDto } from './create-deck.dto';

/**
 * `PATCH /magazine/admin/decks/:id`. Every creation field is patchable, plus
 * `published`, which the service reads to toggle `publishedAt` (true → now
 * if currently null; false → null) rather than mapping it onto an entity
 * column directly.
 */
export class UpdateDeckDto extends PartialType(CreateDeckDto) {
  @IsOptional() @IsBoolean() published?: boolean;
}
