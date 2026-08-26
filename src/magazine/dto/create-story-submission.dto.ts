import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsImageReference } from '../../common/validators/is-image-reference.decorator';

/**
 * Body of `POST /magazine/submissions`. Field names/shape mirror the
 * `SubmitStoryEditor`/`SubmitStoryMeta` FE form (`section` -> `format`,
 * `headline` -> `workingTitle`) and `StorySubmissionResponse` in contracts.ts.
 *
 * `deck`, `body` and `coverImageKey` arrive as their own fields (CON-01). The
 * form used to concatenate deck and body into `pitch` and drop the uploaded
 * cover entirely, so the editor never saw the piece the member actually wrote.
 * `pitch` stays required and stays the SHORT summary: it is what the admin
 * list and the member's own tracker card preview, and every pre-CON-01 row
 * has it.
 */
export class CreateStorySubmissionDto {
  // e.g. one of `SECTIONS` in `submitStory.data.ts` ("Personal essay",
  // "Interview", ...) — not enforced server-side as an enum since the FE
  // section list is editorial config, not a fixed contract.
  @IsString() @MinLength(1) @MaxLength(100) format!: string;

  @IsString() @MinLength(1) @MaxLength(200) workingTitle!: string;

  @IsString() @MinLength(1) @MaxLength(5000) pitch!: string;

  /** The standfirst. Optional: a member may submit with no deck. */
  @IsOptional() @IsString() @MaxLength(1000) deck?: string;

  /**
   * The piece itself. Capped well above the editor's 50-word minimum: a long
   * read runs to thousands of words, and truncating a member's story at the
   * validation boundary would lose the very thing they came to submit.
   */
  @IsOptional() @IsString() @MaxLength(120000) body?: string;

  /**
   * Storage key of the cover uploaded through `useUploadImage("story-cover")`.
   * `@IsImageReference` keeps a `javascript:`/`data:` URI out of the column,
   * and `StorageKeyOwnershipInterceptor` (strict rule — this handler is NOT on
   * the shared-upload allowlist) refuses a key another member uploaded.
   */
  @IsOptional() @IsImageReference() coverImageKey?: string | null;
}
