import { Type } from 'class-transformer';
import { IsArray, IsString, IsUUID, ValidateNested } from 'class-validator';

class RunOrderItemInput {
  @IsUUID()
  pieceId!: string;

  @IsString()
  pages!: string;
}

/**
 * `PATCH /magazine/admin/issues/:number/run-order` body (Magazine Desk
 * Phase 5): replaces the issue's running order wholesale — array order IS
 * the running order. The service also syncs each referenced piece's
 * `orderIndex`/`pages` from this list.
 */
export class UpdateRunOrderDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RunOrderItemInput)
  items!: RunOrderItemInput[];
}
