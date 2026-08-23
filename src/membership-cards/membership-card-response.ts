import { toImageUrl } from '../common/image-url';
import { EffectiveCardStatus } from './card-status';
import {
  CardPhotoStyle,
  CardSkin,
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
  serialPrefix: string;
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
  };
}
