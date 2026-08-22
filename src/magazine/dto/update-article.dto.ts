import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';
import { IsSafeExternalUrl } from '../../common/validators/is-safe-external-url.decorator';

/**
 * `PATCH /magazine/admin/pieces/:id/article` (spec §7.3, plan Phase 3
 * Task 3). Every field is optional — the editor autosaves partial patches as
 * the writer types. `blocks` is typed `unknown` on purpose: the jsonb shape
 * (`ArticleBlock[]`) isn't expressible as class-validator decorators, so
 * it's validated by hand via `validateArticleBlocks` in
 * `magazine-article-blocks.validation.ts`, called by the service before
 * `save()` (mirrors the `UpdatePieceDto.brief`/`care` idiom). Publishing is
 * NOT this DTO's job — see `PublishArticleDto`/`PATCH .../article/publish`.
 *
 * `title` is stored as PLAIN TEXT: the service normalises whatever markup the
 * contentEditable headline sends (`toPlainText`) before persisting, so this
 * column never has to be stripped again on read.
 *
 * Every string is length-capped. Each autosave rewrites the whole row and
 * `snapshotArticleVersion` copies `blocks` per version, so an uncapped field is
 * a multi-megabyte jsonb row multiplied by its history.
 */
export class UpdateArticleDto {
  // Generous enough for a long headline WITH the inline markup the editor
  // sends around it (the stored value is the stripped, shorter plain text).
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  standfirst?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  kicker?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  section?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  role?: string;

  // The `<meta name="description">` budget is ~160 characters; 320 leaves room
  // to draft long and trim rather than rejecting the keystroke that goes over.
  @IsOptional()
  @IsString()
  @MaxLength(320)
  metaDescription?: string;

  // An uploaded storage key or an `https://` URL — the same rule every other
  // image field in the codebase follows, so the global storage-key ownership
  // check and `toImageUrl` both understand it. `''` clears it.
  @IsOptional()
  @IsImageReference()
  socialImage?: string;

  // Emitted into `<link rel="canonical">`/`og:url`. Must not be able to carry
  // `javascript:`/`data:`/`vbscript:`/`file:`.
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsSafeExternalUrl()
  canonicalUrl?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(120, { each: true })
  contentNotes?: string[];

  @IsOptional()
  blocks?: unknown;

  /**
   * The `version` the client last read (see `MagazineArticle.version`). When
   * present, the save is refused with 409 unless the stored row is still at
   * that version, so a second editor's autosave can never silently discard the
   * first's blocks and a stale tab cannot undo a "Restore version".
   *
   * Optional ONLY so an already-deployed editor keeps saving while its client
   * half is updated to round-trip it; it should become required once every
   * client sends it. Omitting it still gets the load→write race closed inside
   * the request, just not the read→edit→write one across requests.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
