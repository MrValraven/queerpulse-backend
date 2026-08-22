import { toImageUrl } from '../common/image-url';
import { EffectiveCardStatus } from './card-status';
import { CardSkin, CommunityCard } from './entities/community-card.entity';
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
  avatarUrl: string | null;
}

export interface CardVerificationDTO {
  status: EffectiveCardStatus;
  issuerName: string;
  holderName: string;
  role: string;
  serial: string;
  memberSince: string;
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
  },
): MyCardDTO {
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
    program: toCardProgram(program),
  };
}

export function toIssuerCard(
  card: MembershipCard,
  status: EffectiveCardStatus,
  holder: { holderSlug: string; holderName: string; avatarUrl: string | null },
): IssuerCardDTO {
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
  context: { issuerName: string; holderName: string; role: string },
): CardVerificationDTO {
  return {
    status,
    issuerName: context.issuerName,
    holderName: context.holderName,
    role: context.role,
    serial: card.serial,
    memberSince: card.issuedAt.toISOString(),
  };
}
