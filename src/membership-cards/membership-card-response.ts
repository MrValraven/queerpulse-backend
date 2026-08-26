import { toImageUrl } from '../common/image-url';
import { EffectiveCardStatus } from './card-status';
import {
  CardPhotoStyle,
  CardSkin,
  CardTextBackdrop,
  CommunityCard,
} from './entities/community-card.entity';
import { MembershipCard } from './entities/membership-card.entity';

export interface CardProgramDTO {
  isEnabled: boolean;
  skin: CardSkin;
  accentToken: string;
  crestUrl: string | null;
  /** A curated ground (a pride flag), drawn by the frontend from this id. */
  backgroundPreset: string | null;
  /** An uploaded ground, already resolved to a fetchable URL. */
  backgroundUrl: string | null;
  cardName: string;
  validityMonths: number | null;
  allowsPrint: boolean;
  allowsWallet: boolean;
  allowsPublicBadge: boolean;
  /** Whether this programme's cards carry the holder's photo at all. */
  allowsMemberPhoto: boolean;
  /** How those photos are printed: in colour, or desaturated. */
  photoStyle: CardPhotoStyle;
  /** Whether this programme's cards print the holder's pronouns. */
  allowsPronouns: boolean;
  /** Which legibility treatment a flag or photo ground carries. */
  textBackdrop: CardTextBackdrop;
  /**
   * Whether a holder may put their own card back in date near expiry, without
   * waiting for an owner to run the roster bulk issue. The client draws its
   * Renew control from this AND the card's own status, and the server checks
   * both again on the write: this field decides what to SHOW, never what is
   * allowed.
   */
  allowsSelfRenew: boolean;
  serialPrefix: string;
}

/**
 * What a member-initiated renewal did to one card.
 *
 * Deliberately thin. The client already holds the whole card and refetches
 * after a successful renew, so the only things worth sending back are the two
 * values that moved. Hand-mapped like every other payload in this file: there
 * is no global serializer, and returning the entity here would put
 * `revokedReason` on a member-facing route.
 */
export interface RenewedCardDTO {
  id: string;
  status: EffectiveCardStatus;
  expiresAt: string | null;
}

export function toRenewedCard(
  card: MembershipCard,
  status: EffectiveCardStatus,
): RenewedCardDTO {
  return {
    id: card.id,
    status,
    expiresAt: card.expiresAt?.toISOString() ?? null,
  };
}

export interface MyCardDTO {
  id: string;
  serial: string;
  status: EffectiveCardStatus;
  issuedAt: string;
  expiresAt: string | null;
  communityName: string;
  communitySlug: string;
  role: string;
  holderName: string;
  /**
   * The face on the card, or null. Resolved server-side from the holder's own
   * profile avatar, and ONLY when the programme allows photos, the member has
   * not hidden theirs, and they actually have one. A client never receives an
   * avatar it is not supposed to draw, so it cannot leak one by rendering the
   * wrong branch.
   */
  holderAvatarUrl: string | null;
  /**
   * The member's own veto, reported separately from `holderAvatarUrl` so the
   * settings control can show its real state. Both a member who turned their
   * photo off and a member whose community never turned photos on have a null
   * avatar; only this distinguishes them.
   */
  isPhotoHidden: boolean;
  /**
   * The pronouns printed on the card, or null. Read server-side from the
   * holder's own profile, and sent ONLY when the programme prints pronouns,
   * the member has not hidden theirs, and they have any set. Gated at this one
   * boundary for the same reason the avatar is: a client cannot leak what it
   * never receives.
   */
  holderPronouns: string | null;
  /**
   * The member's own veto, reported separately from `holderPronouns` so the
   * settings control can show its real state. A member who turned pronouns
   * off, a member whose community never turned them on, and a member with no
   * pronouns on their profile all have a null value; only this distinguishes
   * the first from the other two.
   */
  isPronounsHidden: boolean;
  /**
   * The card's permanent scannable code, or null when the platform has no card
   * signing key configured. Sent whatever the card's status: a printed card
   * exists in the world whatever its status, and the verify page reports the
   * truth about it. The client decides whether to draw it.
   */
  token: string | null;
  program: CardProgramDTO;
}

export interface IssuerCardDTO {
  id: string;
  serial: string;
  status: EffectiveCardStatus;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Issuer-only. Deliberately absent from every other DTO in this file. */
  revokedReason: string | null;
  holderSlug: string;
  holderName: string;
  /**
   * The holder's PROFILE picture, for the roster row. A mod already sees this
   * everywhere else in the community, so it is not gated here.
   */
  avatarUrl: string | null;
  /** The holder's role in the issuing community, as printed on the card. */
  role: string;
  /**
   * The face the card ACTUALLY carries, or null. Gated by the same pair of
   * switches `toMyCard` applies (the programme's photo setting and the
   * holder's own veto), so an issuer looking at a member's card sees the card
   * that member holds rather than a photo they chose to keep off it. Kept
   * separate from `avatarUrl` precisely because those two answers differ.
   */
  cardPhotoUrl: string | null;
  /**
   * The pronouns the card ACTUALLY prints, or null. Gated by the same pair of
   * switches `toMyCard` applies, so an issuer reading a member's card sees the
   * card that member holds rather than pronouns they chose to keep off it.
   */
  cardPronouns: string | null;
  /**
   * The card's permanent scannable code, or null when the platform has no card
   * signing key configured. Sent whatever the card's status: a printed card
   * exists in the world whatever its status, and the verify page reports the
   * truth about it. The client decides whether to draw it.
   */
  token: string | null;
  /**
   * How many times THIS card has been verified inside the 90 day retention
   * window. Per-CARD, never per-member: a card checked far more often than
   * every other card on the roster is how an issuer notices that a copy of it
   * is circulating. There is no history behind it, and no way to ask this
   * question about a person.
   *
   * A COUNT, AND DELIBERATELY NOT A TIMESTAMP. This row already carries the
   * holder's name, photo and pronouns; adding "and they last showed it at
   * 19:42 on Tuesday" would turn a fraud signal into an attendance log that
   * an owner or moderator could read off the API. The programme aggregate
   * below keeps its `lastVerifiedAt`, where it belongs to no one person.
   */
  verificationCount: number;
}

/**
 * How often a community's cards have actually been checked. Aggregate only:
 * two counts and one timestamp, with nothing in it that could say who showed
 * a card, when they showed it, or where. There is deliberately no per-member
 * shape anywhere in this file.
 */
export interface CardVerificationCountsDTO {
  /** Every verification still inside the 90 day retention window. */
  total: number;
  /** Verifications inside the recent window below. */
  recent: number;
  /** How many days `recent` covers, so the client states the real window
   *  instead of hard-coding a number the server could change. */
  recentDays: number;
  /** The most recent verification of any card in this programme, or null. */
  lastVerifiedAt: string | null;
}

export interface CardVerificationDTO {
  status: EffectiveCardStatus;
  issuerName: string;
  holderName: string;
  role: string;
  serial: string;
  memberSince: string;
  /**
   * Whether the card actually carries the holder's face. With one permanent
   * code there is no way to tell a phone screen from a piece of paper, so this
   * is what tells a door whether it has anything to check the person against.
   */
  hasPhoto: boolean;
  /**
   * The pronouns the card prints, or null. Present only when the card itself
   * carries them, so whoever just scanned it can address the person in front
   * of them correctly. A card that does not print pronouns tells a stranger
   * nothing about the holder's, which is the same answer the card gives.
   */
  holderPronouns: string | null;
  /**
   * The face the card prints, as a fetchable URL, or null.
   *
   * Sent so the door compares the person in front of it against the copy the
   * ISSUER holds rather than against the picture on the object being shown —
   * a printed card or a phone screen can be doctored, this cannot. Gated by
   * the same three switches as `hasPhoto` AND by status: only a card that is
   * currently good hands a stranger a face, because there is no door decision
   * a revoked card's photo could inform.
   */
  holderPhotoUrl: string | null;
  /**
   * How the card renders that face. Mirrored here so the portrait a verifier
   * compares against looks like the one printed on the card in their hand
   * rather than a differently-treated second image of the same person.
   */
  photoStyle: CardPhotoStyle;
}

export function toCardProgram(program: CommunityCard): CardProgramDTO {
  return {
    isEnabled: program.isEnabled,
    skin: program.skin,
    accentToken: program.accentToken,
    crestUrl: toImageUrl(program.crestMediaKey),
    backgroundPreset: program.backgroundPreset,
    backgroundUrl: toImageUrl(program.backgroundMediaKey),
    cardName: program.cardName,
    validityMonths: program.validityMonths,
    allowsPrint: program.allowsPrint,
    allowsWallet: program.allowsWallet,
    allowsPublicBadge: program.allowsPublicBadge,
    allowsMemberPhoto: program.allowsMemberPhoto,
    photoStyle: program.photoStyle,
    allowsPronouns: program.allowsPronouns,
    textBackdrop: program.textBackdrop,
    allowsSelfRenew: program.allowsSelfRenew,
    serialPrefix: program.serialPrefix,
  };
}

export function toMyCard(
  card: MembershipCard,
  program: CommunityCard,
  status: EffectiveCardStatus,
  context: {
    communityName: string;
    communitySlug: string;
    role: string;
    holderName: string;
    /** The holder's profile avatar, before either switch is applied. */
    holderAvatarUrl?: string | null;
    /** The holder's profile pronouns, before either switch is applied. */
    holderPronouns?: string | null;
    /** Already minted by the caller, which is the only layer holding the
     *  signing key. Null on a platform with no key configured. */
    token: string | null;
  },
): MyCardDTO {
  // Both switches are enforced HERE, at the one boundary the avatar can leave
  // through, rather than at each render site. A photo the member vetoed or the
  // programme never enabled is not sent at all.
  const canShowPhoto = program.allowsMemberPhoto && !card.isPhotoHidden;
  // The same pair of switches, asked about the other thing a card can say
  // about its holder. Empty pronouns are normalised to null here so the client
  // has one absent-value shape to render against rather than two.
  const canShowPronouns = program.allowsPronouns && !card.isPronounsHidden;
  return {
    id: card.id,
    serial: card.serial,
    status,
    issuedAt: card.issuedAt.toISOString(),
    expiresAt: card.expiresAt?.toISOString() ?? null,
    communityName: context.communityName,
    communitySlug: context.communitySlug,
    role: context.role,
    holderName: context.holderName,
    holderAvatarUrl: canShowPhoto
      ? toImageUrl(context.holderAvatarUrl ?? null)
      : null,
    isPhotoHidden: card.isPhotoHidden,
    holderPronouns: canShowPronouns
      ? context.holderPronouns?.trim() || null
      : null,
    isPronounsHidden: card.isPronounsHidden,
    token: context.token,
    program: toCardProgram(program),
  };
}

/**
 * One issued card, as its ISSUER sees it. Carries the revocation reason (which
 * `toMyCard` withholds) and enough of the card itself — role, and the photo
 * the card really prints — for an owner or mod to look at the object a member
 * is holding, not just a roster row about it.
 */
export function toIssuerCard(
  card: MembershipCard,
  program: CommunityCard,
  status: EffectiveCardStatus,
  holder: {
    holderSlug: string;
    holderName: string;
    /** Already resolved to a fetchable URL by the caller. */
    avatarUrl: string | null;
    /** The holder's profile pronouns, before either switch is applied. */
    pronouns: string | null;
    role: string;
    /** The same permanent code the holder sees. There is nothing
     *  holder-specific to withhold: it is the card's own value. */
    token: string | null;
    /** This card's verification COUNT, already read by the caller from the
     *  scan log. Optional so a caller with no tally in hand reports an honest
     *  zero rather than being forced to invent one. No timestamp travels with
     *  it: see `IssuerCardDTO.verificationCount`. */
    verificationCount?: number;
  },
): IssuerCardDTO {
  // The same one boundary `toMyCard` gates on, applied to the same pair of
  // switches. An issuer may not see a face the card does not print.
  const canShowPhoto = program.allowsMemberPhoto && !card.isPhotoHidden;
  const canShowPronouns = program.allowsPronouns && !card.isPronounsHidden;
  return {
    id: card.id,
    serial: card.serial,
    status,
    issuedAt: card.issuedAt.toISOString(),
    expiresAt: card.expiresAt?.toISOString() ?? null,
    revokedAt: card.revokedAt?.toISOString() ?? null,
    revokedReason: card.revokedReason,
    holderSlug: holder.holderSlug,
    holderName: holder.holderName,
    avatarUrl: holder.avatarUrl,
    role: holder.role,
    cardPhotoUrl: canShowPhoto ? holder.avatarUrl : null,
    cardPronouns: canShowPronouns ? holder.pronouns?.trim() || null : null,
    token: holder.token,
    verificationCount: holder.verificationCount ?? 0,
  };
}

/**
 * The public verification payload. Deliberately the thinnest DTO in this
 * file: a stranger at a door learns whether the card is good and who holds
 * it, and nothing else. In particular a revoked card never says why it was
 * revoked (spec §K.6).
 */
export function toCardVerification(
  card: MembershipCard,
  status: EffectiveCardStatus,
  context: {
    issuerName: string;
    holderName: string;
    role: string;
    hasPhoto: boolean;
    /** Already gated by the caller, the same way `hasPhoto` is. */
    holderPronouns: string | null;
    /** The holder's avatar, before the photo gate or the status gate below. */
    holderAvatarUrl: string | null;
    photoStyle: CardPhotoStyle;
  },
): CardVerificationDTO {
  return {
    status,
    issuerName: context.issuerName,
    holderName: context.holderName,
    role: context.role,
    serial: card.serial,
    memberSince: card.issuedAt.toISOString(),
    hasPhoto: context.hasPhoto,
    holderPronouns: context.holderPronouns,
    // Both gates in one place, the same way `toMyCard` gates the avatar at the
    // single boundary it can leave through. `hasPhoto` already carries the
    // programme switch, the member's veto and whether they have a face at all;
    // the status check is this DTO's own, because this is the only card
    // payload handed to someone who is not the holder or the issuer.
    holderPhotoUrl:
      context.hasPhoto && status === 'active'
        ? toImageUrl(context.holderAvatarUrl)
        : null,
    photoStyle: context.photoStyle,
  };
}

/**
 * The issuer's aggregate. Counts arrive from a raw aggregate query as strings
 * or nulls, so they are normalised to numbers here rather than at each call
 * site, and the timestamp is normalised to ISO the way every other DTO in
 * this file does it.
 */
export function toCardVerificationCounts(counts: {
  total: number;
  recent: number;
  recentDays: number;
  lastVerifiedAt: Date | string | null;
}): CardVerificationCountsDTO {
  const parsed = counts.lastVerifiedAt ? new Date(counts.lastVerifiedAt) : null;
  // A driver that hands back something unparseable must cost the panel its
  // timestamp, never throw a RangeError out of a response mapper.
  const lastVerifiedAt =
    parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null;
  return {
    total: Number.isFinite(counts.total) ? counts.total : 0,
    recent: Number.isFinite(counts.recent) ? counts.recent : 0,
    recentDays: counts.recentDays,
    lastVerifiedAt,
  };
}
