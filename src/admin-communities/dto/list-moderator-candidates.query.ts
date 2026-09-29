import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Longest name search the add-moderator picker accepts. */
export const MODERATOR_CANDIDATE_SEARCH_MAX_LENGTH = 100;

/**
 * Query of `GET /admin/communities/:slug/moderators/candidates` (ENG-492).
 *
 * The picker loads a bounded page of promotable members, so a community with
 * thousands of members answers with a short list the admin narrows by name.
 */
export class ListModeratorCandidatesQuery {
  /**
   * Name or handle search, accent-folded on the server so "Joao" finds
   * "João". Trimmed before validation, so a whitespace-only value reads as no
   * search at all.
   */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(MODERATOR_CANDIDATE_SEARCH_MAX_LENGTH)
  q?: string;
}
