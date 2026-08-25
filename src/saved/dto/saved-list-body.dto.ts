import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body for `POST /me/saved/lists` and `PATCH /me/saved/lists/:listId`.
 *
 * A list name is the member's own words for a reason they are keeping things
 * ("first date", "open late", "trans-friendly healthcare"), so the only rules
 * are that it exists and that it fits the column. The 60-character ceiling
 * matches `saved_lists.name`.
 */
export class SavedListBodyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  name!: string;
}
