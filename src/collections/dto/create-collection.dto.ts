import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Body for `POST /me/collections` — names a new (empty) collection. */
export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  emoji?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  cover?: string;
}
