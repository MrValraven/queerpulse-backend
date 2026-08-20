import { IsString, MaxLength, MinLength } from 'class-validator';

/**
 * `POST /admin/members/:id/cite` body (ADM-9) — a free-text evidence note an
 * admin/moderator attaches to a member's audit trail directly from the trust
 * network graph inspector's "Cite" action. No `reasonCode`: unlike
 * `RestrictMemberDto`, citing evidence isn't an enforcement action against the
 * shared reason taxonomy, just a recorded observation for a human reviewer to
 * read later — the free-text `note` is the whole point.
 */
export class CiteMemberDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  note!: string;
}
