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

/**
 * The headline number on a landlord card, and what it is actually made of.
 *
 * PRD-249. `score` is the mean of self-attested, unverified member ratings of a
 * named third party who has no account here. It is still computed and still
 * shown, because a reader who has to open every recommendation to learn that
 * four people said the same thing is worse served than one who is told. What
 * changed is that it may never be presented as a BARE number: `attestedCount`
 * is served alongside it precisely so no surface can print "4.5" without also
 * being able to say how many of those ratings carry a tenancy attestation
 * behind them, and every rendering of it is labelled self-reported.
 *
 * `attestedCount` is at most `count`, and is lower on any landlord with
 * recommendations written before the attestation existed.
 */
export interface LandlordRatingDTO {
  score: string;
  count: number;
  /**
   * How many of the `count` recommendations carry an author attestation that
   * they rented from this landlord. Always `<= count`; the difference is the
   * historic rows nobody was ever asked about.
   */
  attestedCount: number;
}

/** Aggregate star rating: mean to one decimal + count. Mirrors `listings`
 * `ratingFromReviews`, plus the PRD-249 attested tally. */
export function ratingFromRecommendations(
  recs: LandlordRecommendation[],
): LandlordRatingDTO {
  if (recs.length === 0) return { score: '0', count: 0, attestedCount: 0 };
  const total = recs.reduce((sum, rec) => sum + rec.stars, 0);
  return {
    score: (total / recs.length).toFixed(1),
    count: recs.length,
    attestedCount: recs.filter((rec) => rec.attestedAt !== null).length,
  };
}

/** The empty rating, spelled once so no caller has to remember the third
 *  field. */
export const EMPTY_LANDLORD_RATING: LandlordRatingDTO = {
  score: '0',
  count: 0,
  attestedCount: 0,
};

export interface LandlordCardDTO {
  slug: string;
  name: string;
  initials: string;
  tint: LandlordTint;
  photo: string | null;
  hood: string;
  note: string;
  tagline: string;
  rating: LandlordRatingDTO;
  /**
   * PRD-249. Always `true`, and served on every card and every detail read so
   * no surface can render the rating without it in hand.
   *
   * A CONSTANT rather than a computed flag, deliberately. It is not a property
   * of one landlord that could come out false on another: this entire directory
   * rates real third parties who have no account here, from claims the platform
   * cannot check. Serving it as a field rather than leaving it to each client
   * to remember is what stops a new surface from quietly shipping a bare star
   * count. It becomes something other than a constant on the day a rating here
   * can be verified, which is not a day anyone has designed.
   */
  isRatingSelfReported: true;
}

export function toLandlordCardDTO(
  landlord: Landlord,
  rating: LandlordRatingDTO,
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
    // PRD-249. Never omitted, on any card, so no client can render the score
    // above without the label that qualifies it.
    isRatingSelfReported: true,
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
  /**
   * PRD-249. Always `true`, on every recommendation, historic ones included.
   *
   * A CONSTANT, exactly like `LandlordCardDTO.isRatingSelfReported`, and served
   * as a field for the same reason: so a client cannot render one of these
   * without the label in hand. What varies row to row is `attestation` below,
   * which says whether the author was ever asked to back the claim up. What
   * never varies is that nothing on this platform has checked it.
   */
  isSelfAttested: true;
  /**
   * The author's own claim that they rented from this landlord, and roughly
   * when. `null` on a recommendation written before the platform asked, which
   * is a weaker row than an attested one and reads as such on the page.
   */
  attestation: RecommendationAttestationDTO | null;
  /**
   * The named landlord's published answer to this recommendation, or `null`
   * when there is none. Transcribed and published by staff, because a landlord
   * here has no account. See `LandlordsService.publishLandlordReply`.
   */
  landlordReply: LandlordReplyDTO | null;
}

/**
 * What the author attested to, and nothing more. There is no `verifiedBy`,
 * no `proof` and no `source` field here, and there must never be one until
 * something on this platform actually checks a tenancy.
 */
export interface RecommendationAttestationDTO {
  /** `YYYY-MM`. Month precision: see `tenancy-month.ts`. */
  tenancyStartedOn: string;
  /** `YYYY-MM`, or `null` when the author says they still rent from them. */
  tenancyEndedOn: string | null;
  /** When the attestation was made (which is when the recommendation was last
   *  written). */
  attestedAt: string;
}

/**
 * One published landlord reply. `publishedByStaff` is always `true` and is
 * there to be rendered: a reader has to be able to tell that these words
 * reached the page through a staff member rather than from an account the
 * landlord holds, because the landlord holds none.
 *
 * The publishing admin's user id is deliberately NOT here. It is on the row for
 * the audit trail and belongs behind the staff guard, and naming an individual
 * moderator beside a public reply about a housing dispute puts a target on
 * them.
 */
export interface LandlordReplyDTO {
  text: string;
  publishedAt: string;
  publishedByStaff: true;
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
    isSelfAttested: true,
    attestation: toAttestationDTO(rec),
    landlordReply: toLandlordReplyDTO(rec),
  };
}

/**
 * The attestation block, or `null` for a row written before the platform asked.
 *
 * `attestedAt` is the discriminator, and `tenancyStartedOn` is checked
 * alongside it rather than assumed: a row can only carry one without the other
 * through a hand-written database edit, and the honest answer to a half-written
 * attestation is "there is no attestation on this one", never a window with a
 * missing end.
 */
function toAttestationDTO(
  rec: LandlordRecommendation,
): RecommendationAttestationDTO | null {
  if (!rec.attestedAt || !rec.tenancyStartedOn) return null;
  return {
    tenancyStartedOn: rec.tenancyStartedOn,
    tenancyEndedOn: rec.tenancyEndedOn,
    attestedAt: rec.attestedAt.toISOString(),
  };
}

/** The published landlord reply, or `null`. Both columns are required for a
 *  reply to exist: text with no timestamp is a half-written row, and the page
 *  needs the date to say when the answer came. */
function toLandlordReplyDTO(
  rec: LandlordRecommendation,
): LandlordReplyDTO | null {
  if (!rec.landlordReplyText || !rec.landlordReplyPublishedAt) return null;
  return {
    text: rec.landlordReplyText,
    publishedAt: rec.landlordReplyPublishedAt.toISOString(),
    publishedByStaff: true,
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
  /**
   * PRD-249. The staff `users.id` who published the landlord's reply on this
   * recommendation, `null` when there is no reply.
   *
   * STAFF-ONLY, which is why it is here and deliberately absent from
   * `LandlordReplyDTO`. Publishing a named third party's words about a housing
   * dispute is an act somebody has to be answerable for, so the audit key is
   * kept; naming the individual moderator to every member reading the page
   * would point a dispute at them personally.
   */
  landlordReplyPublishedBy: string | null;
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
    landlordReplyPublishedBy: rec.landlordReplyPublishedBy,
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
  rating: LandlordRatingDTO,
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
  rating: LandlordRatingDTO,
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
