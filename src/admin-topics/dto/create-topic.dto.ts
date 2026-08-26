import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `POST /admin/topics` body.
 *
 * The tag shape matches `topics/dto/topic-slug.param.ts` exactly, so a topic
 * can never be created under a tag the follow endpoints would then reject as
 * malformed.
 */
export class CreateTopicDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'tag must be a lowercase, hyphen-separated topic slug',
  })
  tag!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  label!: string;

  @IsString()
  @MaxLength(2000)
  description!: string;

  /** Surfaces the crisis-support sidebar card on the topic page. */
  @IsOptional()
  @IsBoolean()
  isCrisisCard?: boolean;
}
