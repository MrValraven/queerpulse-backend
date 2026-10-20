import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioRelease } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  canCounterClaim,
  canReplyToClaim,
  canWithdrawClaim,
} from './studio-claim-rule';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import {
  StudioArtistPersona,
  StudioArtistRef,
  hasPlayableAudio,
  isWithheldTrack,
  toStudioArtistRef,
} from './studio-response';
import {
  StudioContentWarningId,
  effectiveContentWarnings,
  normalizeContentWarnings,
} from './studio-safety.constants';

// Studio safety and moderation: the wire shapes of copyright claims and the
// staff track card (QUEERPULSE-STUDIO-SAFETY-MODERATION-CONTRACT-2026-10-14.md).
// The owner view names nothing about the claimant; the claimant view names
// the artist persona only; staff see the claimant and the persona, and the
// member who runs the persona stays hidden from everyone.

/** Owner view. Never names or hints at the claimant. `status` is one of
 *  `accepted`, `countered`, `upheld`, `rejected`. */
export interface StudioOwnerClaim {
  id: string;
  trackId: string;
  status: StudioCopyrightClaimStatus;
  originalWork: string;
  originalLink: string | null;
  details: string;
  claimantRole: StudioClaimantRole;
  counterNote: string | null;
  claimantReply: string | null;
  /** Set on upheld and rejected. */
  staffNote: string | null;
  acceptedAt: string;
  counteredAt: string | null;
  decidedAt: string | null;
  canCounter: boolean;
}

/** Claimant view (`GET /me/studio/copyright-claims` and every claimant
 *  write). Once a persona unlink severs the claim, `track` carries the
 *  title and artist name kept at filing, and every id, the release title
 *  and the live artist ref are null, so the view never names the
 *  pseudonymous persona. */
export interface StudioMyClaim {
  id: string;
  status: StudioCopyrightClaimStatus;
  claimantRole: StudioClaimantRole;
  originalWork: string;
  originalLink: string | null;
  details: string;
  counterNote: string | null;
  claimantReply: string | null;
  /** Set on declined, upheld and rejected. */
  staffNote: string | null;
  createdAt: string;
  acceptedAt: string | null;
  counteredAt: string | null;
  repliedAt: string | null;
  decidedAt: string | null;
  canReply: boolean;
  canWithdraw: boolean;
  track: {
    /** Null when severed. */
    id: string | null;
    title: string;
    /** Both null when severed. */
    release: { id: string | null; title: string | null };
    /** Null when severed. */
    artist: StudioArtistRef | null;
    /** The live persona name, or the name kept at filing when severed. */
    artistName: string;
  };
}

/** The `StudioPlaylistMemberCredit` shape: who filed, for staff only. */
export interface StudioClaimantRef {
  id: string;
  slug: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Staff view: the Claims tab card. */
export interface StudioAdminClaim {
  id: string;
  status: StudioCopyrightClaimStatus;
  claimantRole: StudioClaimantRole;
  originalWork: string;
  originalLink: string | null;
  details: string;
  counterNote: string | null;
  claimantReply: string | null;
  staffNote: string | null;
  createdAt: string;
  acceptedAt: string | null;
  counteredAt: string | null;
  repliedAt: string | null;
  decidedAt: string | null;
  claimant: StudioClaimantRef;
  track: { id: string; title: string; position: number; isWithheld: boolean };
  release: StudioAdminReleaseSummary;
}

/** `GET /admin/studio/copyright-claims/counts`; the tab badge is the sum. */
export interface StudioAdminClaimCounts {
  submitted: number;
  countered: number;
}

/** Staff read of one track: the reports tab track card and the answer of
 *  both track actions. */
export interface StudioAdminTrack {
  id: string;
  releaseId: string;
  position: number;
  title: string;
  durationSeconds: number | null;
  hasAudio: boolean;
  isExplicit: boolean;
  isExplicitLocked: boolean;
  contentWarnings: StudioContentWarningId[];
  artistContentWarnings: StudioContentWarningId[];
  staffContentWarnings: StudioContentWarningId[];
  isWithheld: boolean;
  release: StudioAdminReleaseSummary;
}

/** What a claimant's card reads beside the claim row. */
export interface StudioClaimTrackContext {
  track: Pick<StudioTrack, 'id' | 'title'>;
  release: Pick<StudioRelease, 'id' | 'title'>;
  persona: StudioArtistPersona;
}

/** What a staff card reads beside the claim row. */
export interface StudioAdminClaimContext {
  track: Pick<StudioTrack, 'id' | 'title' | 'position' | 'withheldAt'>;
  release: StudioAdminReleaseSummary;
  claimant: StudioClaimantRef;
}

function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/** For owner-visible claims only; the reads filter on
 *  `OWNER_VISIBLE_CLAIM_STATUSES` first. Every owner-visible claim passed
 *  through accept (`CHK_studio_copyright_claims_accepted`). */
export function toStudioOwnerClaim(
  claim: StudioCopyrightClaim,
): StudioOwnerClaim {
  return {
    id: claim.id,
    trackId: claim.trackId,
    status: claim.status,
    originalWork: claim.originalWork,
    originalLink: claim.originalLink,
    details: claim.details,
    claimantRole: claim.claimantRole,
    counterNote: claim.counterNote,
    claimantReply: claim.claimantReply,
    staffNote: claim.staffNote,
    acceptedAt: (claim.acceptedAt ?? claim.createdAt).toISOString(),
    counteredAt: isoOrNull(claim.counteredAt),
    decidedAt: isoOrNull(claim.decidedAt),
    canCounter: canCounterClaim(claim),
  };
}

/** The claimant's card. `context` is read only while the claim is not
 *  severed; a severed claim, or one with no context, answers from the names
 *  kept at filing. */
export function toStudioMyClaim(
  claim: StudioCopyrightClaim,
  context: StudioClaimTrackContext | null,
): StudioMyClaim {
  return {
    id: claim.id,
    status: claim.status,
    claimantRole: claim.claimantRole,
    originalWork: claim.originalWork,
    originalLink: claim.originalLink,
    details: claim.details,
    counterNote: claim.counterNote,
    claimantReply: claim.claimantReply,
    staffNote: claim.staffNote,
    createdAt: claim.createdAt.toISOString(),
    acceptedAt: isoOrNull(claim.acceptedAt),
    counteredAt: isoOrNull(claim.counteredAt),
    repliedAt: isoOrNull(claim.repliedAt),
    decidedAt: isoOrNull(claim.decidedAt),
    canReply: canReplyToClaim(claim),
    canWithdraw: canWithdrawClaim(claim),
    track:
      claim.isSevered || !context
        ? {
            id: null,
            title: claim.trackTitleAtFiling,
            release: { id: null, title: null },
            artist: null,
            artistName: claim.artistNameAtFiling,
          }
        : {
            id: context.track.id,
            title: context.track.title,
            release: { id: context.release.id, title: context.release.title },
            artist: toStudioArtistRef(context.persona),
            artistName: context.persona.displayName,
          },
  };
}

export function toStudioAdminClaim(
  claim: StudioCopyrightClaim,
  context: StudioAdminClaimContext,
): StudioAdminClaim {
  return {
    id: claim.id,
    status: claim.status,
    claimantRole: claim.claimantRole,
    originalWork: claim.originalWork,
    originalLink: claim.originalLink,
    details: claim.details,
    counterNote: claim.counterNote,
    claimantReply: claim.claimantReply,
    staffNote: claim.staffNote,
    createdAt: claim.createdAt.toISOString(),
    acceptedAt: isoOrNull(claim.acceptedAt),
    counteredAt: isoOrNull(claim.counteredAt),
    repliedAt: isoOrNull(claim.repliedAt),
    decidedAt: isoOrNull(claim.decidedAt),
    claimant: context.claimant,
    track: {
      id: context.track.id,
      title: context.track.title,
      position: context.track.position,
      isWithheld: isWithheldTrack(context.track),
    },
    release: context.release,
  };
}

export function toStudioAdminTrack(
  track: StudioTrack,
  release: StudioAdminReleaseSummary,
): StudioAdminTrack {
  return {
    id: track.id,
    releaseId: track.releaseId,
    position: track.position,
    title: track.title,
    durationSeconds: track.durationSeconds,
    hasAudio: hasPlayableAudio(track),
    isExplicit: track.isExplicit,
    isExplicitLocked: Boolean(track.explicitLockedAt),
    contentWarnings: effectiveContentWarnings(
      track.contentWarnings,
      track.staffContentWarnings,
    ),
    artistContentWarnings: normalizeContentWarnings(track.contentWarnings),
    staffContentWarnings: normalizeContentWarnings(track.staffContentWarnings),
    isWithheld: isWithheldTrack(track),
    release,
  };
}
