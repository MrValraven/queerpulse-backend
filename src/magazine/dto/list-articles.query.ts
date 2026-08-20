import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class ListArticlesQuery {
  // Issue display number, e.g. "09" (matches `MagazineIssue.number`).
  @IsOptional()
  @IsString()
  issue?: string;

  @IsOptional()
  @IsString()
  tag?: string;

  // `magazine_section.name` (see `MagazineSection`) — lets the section/topic
  // browse page (`GET /magazine/articles?section=<name>`) ask for just that
  // section's published pieces. `MagazineArticle.section` is free text, so
  // this is an exact string match with no validation against the seeded
  // taxonomy — a drifted section name just yields zero rows, mirroring the
  // `tag`/`author` filters above.
  @IsOptional()
  @IsString()
  section?: string;

  // `magazine_author.slug` — lets AuthorPage's "Selected work" grid ask for
  // just this byline's pieces (GET /magazine/articles?author=<slug>).
  @IsOptional()
  @IsString()
  author?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;
}
