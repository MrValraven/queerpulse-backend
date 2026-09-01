import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { VerificationLevel } from '../verification/verification-level';
import { LandlordIntroRequest } from './entities/landlord-intro-request.entity';
import { LandlordRecommendation } from './entities/landlord-recommendation.entity';
import { Landlord, LandlordStat } from './entities/landlord.entity';

export type LandlordTint = 'coral' | 'jade' | 'plum';
const TINTS: LandlordTint[] = ['coral', 'jade', 'plum'];

/** Stable per-key tint so a card keeps its colour across requests. */
function tintForKey(key: string): LandlordTint {
  let hash = 0;
  for (const char of key) {
    hash = (hash + char.charCodeAt(0)) % TINTS.length;
  }
  // invariant: `hash` is kept in `[0, TINTS.length)` by the `% TINTS.length`
  // in the loop, so it is always a valid index of the non-empty TINTS constant.
  return TINTS[hash]!;
}

/** Two-letter initials from a display name. */
function initialsForName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const firstWord = words[0] ?? '';
  if (words.length === 1) return firstWord.slice(0, 2).toUpperCase();
  const secondWord = words[1] ?? '';
  return ((firstWord[0] ?? '') + (secondWord[0] ?? '')).toUpperCase();
}

function memberName(member: MemberRef | null): string {
  if (!member) return '';
  return `${member.firstName} ${member.lastName}`.trim();
}

/** Aggregate star rating: mean to one decimal + count. Mirrors `listings`
 * `ratingFromReviews`. */
export function ratingFromRecommendations(recs: LandlordRecommendation[]): {
  score: string;
  count: number;
} {
  if (recs.length === 0) return { score: '0', count: 0 };
  const total = recs.reduce((sum, rec) => sum + rec.stars, 0);
  return { score: (total / recs.length).toFixed(1), count: recs.length };
}

export interface LandlordCardDTO {
  slug: string;
  name: string;
  initials: string;
  tint: LandlordTint;
  photo: string | null;
  hood: string;
  note: string;
  tagline: string;
  rating: { score: string; count: number };
}

export function toLandlordCardDTO(
  landlord: Landlord,
  rating: { score: string; count: number },
): LandlordCardDTO {
  return {
    slug: landlord.slug,
    name: landlord.name,
    initials: initialsForName(landlord.name),
    tint: tintForKey(landlord.slug),
    photo: toImageUrl(landlord.photo),
    hood: landlord.hood,
    note: landlord.note,
    tagline: landlord.tagline,
    rating,
  };
}

export interface RecommendationDTO {
  /**
   * The recommendation's own uuid, and the ONLY new field a public reader
   * gained here.
   *
   * It used to be withheld on the reasoning that a public reader has no use for
   * another member's primary key. That reasoning ran out: with
   * `landlord_recommendation` in the report taxonomy, this id is what a member
   * points their complaint at, and without it their only report control names
   * the whole directory entry, so acting on it takes down every other tenant's
   * warning about that landlord too. It is a report handle, and it addresses
   * nothing a reader could not already read on the page: there is no
   * member-facing route that mutates a recommendation by id (the author
   * withdraws theirs by landlord slug, and the takedown routes are behind the
   * moderator guard).
   */
  id: string;
  /** Empty when the author has erased their account, alongside a `null`
   * `member`. Render a removed-member placeholder; never assume a byline. */
  name: string;
  initials: string;
  tint: LandlordTint;
  /** `null` for a recommendation whose author has since erased their account
   * (`authorUserId` is `ON DELETE SET NULL`), and for one whose profile row is
   * missing. Both read the same way on the page: the warning stands, the byline
   * is gone. */
  member: MemberRef | null;
  /** The recommending MEMBER's real verification level — an honest badge on the
   * recommendation. The landlord themselves is NOT a platform member and never
   * verified with us, so no landlord-level badge is claimed anywhere. */
  verificationLevel: VerificationLevel;
  stars: number;
  text: string;
  createdAt: string;
}

export function toRecommendationDTO(
  rec: LandlordRecommendation,
  member: MemberRef | null,
  verificationLevel: VerificationLevel,
): RecommendationDTO {
  const name = memberName(member);
  return {
    id: rec.id,
    name,
    initials: initialsForName(name),
    // Falls back to the row's own id once the author has been erased, so an
    // anonymised recommendation still gets a stable colour instead of throwing
    // on a NULL author.
    tint: tintForKey(rec.authorUserId ?? rec.id),
    member,
    verificationLevel,
    stars: rec.stars,
    text: rec.text,
    createdAt: rec.createdAt.toISOString(),
  };
}

/**
 * A moderator's view of one recommendation (LOC-19).
 *
 * The `id` moved down to `RecommendationDTO` once a member gained the ability
 * to report a single recommendation, so what this adds is the moderation state:
 * the admin reads deliberately do NOT filter takedowns out, so staff can see
 * what they took down and lift it again. `moderation` is how the console tells
 * a live recommendation from a withheld one. Only ever returned from behind the
 * moderator/admin guard.
 */
export interface AdminRecommendationDTO extends RecommendationDTO {
  moderation: RecommendationModerationDTO;
}

/**
 * Whether a takedown currently stands on this recommendation.
 *
 * `hidden` withholds the words; `removed` tombstones them. Both are lifted by
 * `DELETE /admin/landlords/recommendations/:id/takedown`, and neither touches
 * the row, so lifting either restores the original text exactly. A
 * recommendation that was HARD-deleted before this mechanism existed is not
 * represented here at all: it is gone, and nothing can bring it back.
 */
export interface RecommendationModerationDTO {
  hidden: boolean;
  removed: boolean;
}

export function toAdminRecommendationDTO(
  rec: LandlordRecommendation,
  member: MemberRef | null,
  verificationLevel: VerificationLevel,
  moderation: RecommendationModerationDTO,
): AdminRecommendationDTO {
  return {
    ...toRecommendationDTO(rec, member, verificationLevel),
    moderation,
  };
}

export interface LandlordDetailDTO extends LandlordCardDTO {
  about: string[];
  areas: string[];
  rentingNote: string;
  stats: LandlordStat[];
  recommendations: RecommendationDTO[];
}

export function toLandlordDetailDTO(
  landlord: Landlord,
  recommendations: RecommendationDTO[],
  rating: { score: string; count: number },
): LandlordDetailDTO {
  return {
    ...toLandlordCardDTO(landlord, rating),
    about: landlord.about,
    areas: landlord.areas,
    rentingNote: landlord.rentingNote,
    stats: landlord.stats,
    recommendations,
  };
}

/**
 * A moderator's row in the landlord directory console (LOC-19).
 *
 * The admin list used to hand back the same `LandlordCardDTO` the public
 * browse returns, which made the console impossible to build: no `id` (every
 * admin mutation is keyed by `:id`), no `status`, no submitter and no decision
 * history. Those five fields are what this adds, and nothing else — the card's
 * public fields are already the right summary of the entry itself.
 *
 * `decidedBy` is the raw staff `users.id`; this response is behind the
 * moderator/admin role guard, and it is the audit key.
 */
export interface AdminLandlordDTO extends LandlordCardDTO {
  id: string;
  status: Landlord['status'];
  /** The member who suggested the entry, `null` for a staff-created one. */
  submittedBy: MemberRef | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  createdAt: string;
}

export function toAdminLandlordDTO(
  landlord: Landlord,
  rating: { score: string; count: number },
  submittedBy: MemberRef | null,
): AdminLandlordDTO {
  return {
    ...toLandlordCardDTO(landlord, rating),
    id: landlord.id,
    status: landlord.status,
    submittedBy,
    decidedAt: landlord.decidedAt ? landlord.decidedAt.toISOString() : null,
    decidedBy: landlord.decidedBy,
    decisionReason: landlord.decisionReason,
    createdAt: landlord.createdAt.toISOString(),
  };
}

/**
 * Admin-facing intro-request row (includes the landlord it targets).
 *
 * `requester`, `decidedAt`, `decidedBy` and `decisionReason` are the LOC-19
 * additions. A moderator answering "can you introduce me?" was working from a
 * self-entered `name` and nothing else: no way to see which member is asking,
 * and no record of who answered, when, or what they said. `contactEmail` is
 * the requester's own submitted contact detail and stays on this staff-only
 * row, exactly as before.
 */
export interface IntroRequestDTO {
  id: string;
  landlordSlug: string;
  landlordName: string;
  name: string;
  note: string | null;
  contactEmail: string | null;
  status: LandlordIntroRequest['status'];
  createdAt: string;
  /** The member who asked, `null` when the account has since been erased. */
  requester: MemberRef | null;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
}

export function toIntroRequestDTO(
  request: LandlordIntroRequest,
  landlord: Pick<Landlord, 'slug' | 'name'> | null,
  requester: MemberRef | null = null,
): IntroRequestDTO {
  return {
    id: request.id,
    landlordSlug: landlord?.slug ?? '',
    landlordName: landlord?.name ?? '',
    name: request.name,
    note: request.note,
    contactEmail: request.contactEmail,
    status: request.status,
    createdAt: request.createdAt.toISOString(),
    requester,
    decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    decidedBy: request.decidedBy,
    decisionReason: request.decisionReason,
  };
}
