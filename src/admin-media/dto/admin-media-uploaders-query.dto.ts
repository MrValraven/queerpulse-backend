import { IsOptional, IsString, MaxLength } from 'class-validator';

// Admin `GET /admin/media/uploaders` query — the typeahead behind the media
// console's "filter by uploader" search box. `q` is a free-text name/handle
// term; the service trims it, ignores anything under 2 chars (returns []), and
// escapes it for `ILIKE`. Capped so a pathological term can't bloat the query.
export class AdminMediaUploadersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
