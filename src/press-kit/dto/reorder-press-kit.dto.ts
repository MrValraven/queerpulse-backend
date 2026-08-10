import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';

// Shared by both reorder endpoints (coverage and contacts). `orderedIds` must
// be EXACTLY the current set of ids for that list — validated inside
// `PressKitService`, not here (it requires a DB read).
export class ReorderPressKitDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  orderedIds!: string[];
}
