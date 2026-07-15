import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Body of `POST /magazine/submissions`. Field names/shape mirror the
 * `SubmitStoryEditor`/`SubmitStoryMeta` FE form (`section` -> `format`,
 * `headline` -> `workingTitle`, `deck`/`body` -> `pitch`) and
 * `StorySubmissionResponse` in contracts.ts.
 */
export class CreateStorySubmissionDto {
  // e.g. one of `SECTIONS` in `submitStory.data.ts` ("Personal essay",
  // "Interview", ...) — not enforced server-side as an enum since the FE
  // section list is editorial config, not a fixed contract.
  @IsString() @MinLength(1) @MaxLength(100) format: string;

  @IsString() @MinLength(1) @MaxLength(200) workingTitle: string;

  @IsString() @MinLength(1) @MaxLength(5000) pitch: string;
}
