import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

// `POST /magazine/articles/:slug/comments` body — a top-level comment, or a
// reply when `parentId` is given (must reference an existing top-level
// comment on the same article; enforced in
// `MagazineReaderCommentsService.create`, not here).
export class CreateReaderCommentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10000)
  body!: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
