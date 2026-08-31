import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_PAGE } from '../../common/pagination';

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

  // CON-12 — free-text search across the magazine's own archive. Matched
  // against the `search_vector` generated column (title, dek, standfirst,
  // tags, and both body representations) with `to_tsquery`, and results are
  // ranked by `ts_rank_cd` rather than returned in publish order. See
  // `MagazineService.listArticles`.
  //
  // Length-capped because the term is tokenized into a `to_tsquery` string:
  // 200 characters is far past any real search and keeps a pathological
  // paste from building a huge AND-chain of prefix terms.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  // CON-16 — the reader's language. When a piece in the result has a
  // published translation in this locale, the translation is served in its
  // place; pieces with no translation stay in the language they were written
  // in, and each row states its own `locale`.
  //
  // Deliberately NOT validated against the locale set: a shared link carrying
  // `?lang=fr` must return the magazine, not a 400. `toArticleLocale`
  // narrows it and treats anything unrecognised as "no preference".
  // Length-capped so the value stays a language tag.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  lang?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE)
  page?: number;
}
