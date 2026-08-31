import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { SavedKind } from '../entities/saved-item.entity';

/**
 * The mutable subset `PUT /me/saved/:id` accepts (frontend `SavedItemBody`
 * in `saved.api.ts`) — everything the client-side `SavedItem` carries except
 * `id` (in the URL) and the server-assigned `savedAt`.
 *
 * Every field here is a presentational SNAPSHOT the client copies off whatever
 * it is bookmarking, and every one of them lands in an unbounded column
 * (`saved_item.title`/`href`/`meta`/`readTime` are `varchar` with no length,
 * `description` is `text`). That made this DTO the loosest write in the module
 * (ENG-45): five `@IsString()` fields with no ceiling, member-controlled, and
 * `title`/`meta`/`description` are echoed verbatim onto the `@Public()` share
 * read (`SharedSavedListController` → `SavedListsService.getShared` →
 * `toSavedItemDTO`), which is served to whoever holds a share link with no
 * account at all.
 *
 * `href` ALSO ships on that public payload. Nothing renders it there today
 * (`SavedListSharedPage`'s `SharedSavedListRow` prints only `title`, `meta` and
 * `description`), so the cost is a stored value waiting for the first component
 * that does link it rather than a live sink. That is precisely the state
 * `CreateDraftDto.href` was in before CNT-15 closed it, so this mirrors that
 * fix rather than inventing a second answer to the same question.
 *
 * The caps below are sized off the UPSTREAM field each snapshot is copied from,
 * not off a round number: a bookmark records what the source page showed, so a
 * cap tighter than the source column can hold would 400 a save of a perfectly
 * legal job posting or article.
 */
export class SavedItemBodyDto {
  @IsEnum(SavedKind)
  kind!: SavedKind;

  /**
   * 500, matching `DESK_TITLE_MAX` — the widest title anything saveable can
   * have. `kind: 'article'` snapshots a `magazine_piece.title`, which that
   * constant governs precisely because the article editor can mirror 2 000
   * characters of contentEditable markup down onto it. Every other source
   * title (job, event, community, forum thread, listing) is capped at 200
   * upstream, so this ceiling is set by the magazine and clears the rest.
   */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  title!: string;

  /**
   * Where the saved card navigates. Restricted to an APP-RELATIVE path, the
   * same rule and the same regex as `CreateDraftDto.href` (CNT-15); this DTO
   * had drifted away from that sibling.
   *
   * Verified against every call site that builds a `SavedItem`, which is the
   * complete input surface: `putSaved` and `addItemToSavedList` are the only
   * two writers, both are reached only through `savedItemToBody`, and all
   * eighteen constructors send a router path. Some are literals
   * (`/studio/track`, `/work/landlord/${slug}`, `/members/${slug}`), some are
   * `routeMap` constants (`routes.film`, `routes.venue`, `routes.directory`),
   * some are path helpers (`thread()`, `businessPath()`), and the magazine
   * toolbar sends `window.location.pathname + search`, which the browser has
   * already percent-encoded. NOT ONE points at an external host: saving a
   * venue stores `${routes.venue}/${id}`, the in-app venue page, never the
   * venue's own website. So an app-relative rule refuses nothing legitimate,
   * and a scheme allowlist permitting `https://` would be a wider door than
   * any real save needs.
   *
   * The pattern rejects a leading `//` and `/\`, which browsers resolve as
   * PROTOCOL-RELATIVE (`//evil.example` navigates off-site), and any
   * whitespace, which would let a scheme be smuggled past a naive prefix
   * check. An empty string is allowed: forms send `''` for an unset field and
   * `@IsOptional()` only skips `undefined`/`null`.
   *
   * 2 000 is the same ceiling `CreateDraftDto.href` uses. Real values are
   * short slugs, so this is headroom rather than a limit anything approaches.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  @Matches(/^(?:|\/(?![/\\])\S*)$/, {
    message: 'href must be an app-relative path starting with "/"',
  })
  href?: string;

  /**
   * The small supporting line under the title, which every call site builds by
   * joining two upstream one-liners with " · ": `${article.byline} ·
   * ${article.readTime}` and `${job.organization} · ${job.location}` are the
   * two widest, and both are 200 + 3 + 200 = 403 at their absolute maximum.
   * 500 covers that with room to spare and matches the codebase's existing
   * "a sentence of display copy" tier (`DESK_BLURB_MAX`).
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  meta?: string;

  /**
   * 10 000, the ceiling on the source columns this is copied from. The jobs
   * card blurb (`CreateJobDto.description` → `Job.desc`) and
   * `CreateEventDto.description` both allow exactly that much, and the jobs
   * page snapshots `job.description` whole. A tighter cap here would reject
   * the save of a long-but-legal job posting, and it is the same number
   * `CreateDraftDto.desc` and `DESK_BODY_MAX` already settled on for "a prose
   * body somebody actually wrote".
   */
  @IsOptional()
  @IsString()
  @MaxLength(10000)
  description?: string;

  /**
   * 200, matching `CreateDeckDto.readTime` — the one upstream field this is
   * ever copied from (`ArticlePage` passes `article.readTime` straight
   * through). Real values are tiny ("6 min", "1h 48m"), but the cap tracks the
   * column rather than the sample so the two write paths cannot disagree about
   * what a legal value is.
   */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  readTime?: string;
}
