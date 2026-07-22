import { toImageUrl } from '../common/image-url';
import { User } from '../users/entities/user.entity';
import { Invite, InviteStatus } from './entities/invite.entity';

const DAY_MS = 24 * 60 * 60 * 1000;

// The status the recipient's landing page acts on. The frontend shows the
// welcome screen only for 'valid'; everything else routes to "invalid/expired".
export type PublicInviteStatus = 'valid' | 'expired' | 'used' | 'revoked';

export interface PublicInviterView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  memberSince?: string;
}

export interface PublicInviteView {
  code: string;
  status: PublicInviteStatus;
  expiresAt: string | null;
  validForDays: number | null;
  memberCount: number;
  inviter: PublicInviterView;
  note: string | null;
  vouch: string | null;
}

// Explicit terminal states from the DB win over time-based expiry: an accepted
// invite is 'used' and a cancelled one is 'revoked' regardless of the clock.
// Only a still-pending invite is checked against expires_at.
export function resolveInviteStatus(
  invite: Invite,
  now: Date,
): PublicInviteStatus {
  if (invite.status === InviteStatus.Revoked) {
    return 'revoked';
  }
  if (invite.status === InviteStatus.Accepted) {
    return 'used';
  }
  if (invite.status === InviteStatus.Expired) {
    return 'expired';
  }
  if (invite.expiresAt && invite.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'valid';
}

// The inviter-facing row shape for GET /invites (the member's own invites).
// Whitelisted fields only — never internal ids — with a freshly-computed status
// so a not-yet-swept expiry reads as 'expired' instead of a stale 'pending'.
export interface MyInviteView {
  code: string;
  note: string | null;
  vouch: string | null;
  email: string | null;
  status: PublicInviteStatus;
  expiresAt: string | null;
  createdAt: string;
}

export function toMyInviteView(invite: Invite, now: Date): MyInviteView {
  return {
    code: invite.code,
    note: invite.note ?? null,
    vouch: invite.vouch ?? null,
    email: invite.email ?? null,
    status: resolveInviteStatus(invite, now),
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    createdAt: invite.createdAt.toISOString(),
  };
}

// Builds the limited, non-sensitive payload returned by GET /invites/:code.
// Reachable by anyone holding the link, so it exposes only public profile
// fields — never emails, ids, or other inviter data.
export function toPublicInviteView(
  invite: Invite,
  inviter: User | null,
  memberCount: number,
  now: Date,
): PublicInviteView {
  const profile = inviter?.profile;
  // "Member since <year>" — prefer the year they became active, falling back to
  // account creation for any legacy record missing activated_at.
  const memberSince = inviter
    ? String((inviter.activatedAt ?? inviter.createdAt).getUTCFullYear())
    : undefined;
  // The configured validity window (created_at → expires_at), in whole days,
  // for the static "Valid for N days" badge.
  const validForDays = invite.expiresAt
    ? Math.round(
        (invite.expiresAt.getTime() - invite.createdAt.getTime()) / DAY_MS,
      )
    : null;

  return {
    code: invite.code,
    status: resolveInviteStatus(invite, now),
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    validForDays,
    memberCount,
    inviter: {
      slug: profile?.slug ?? '',
      firstName: profile?.firstName ?? '',
      lastName: profile?.lastName ?? '',
      avatarUrl: toImageUrl(profile?.avatarUrl),
      ...(memberSince ? { memberSince } : {}),
    },
    note: invite.note ?? null,
    vouch: invite.vouch ?? null,
  };
}

// The invite-quota panel on the compose page: how many personal invites the
// member has left this calendar month, and when the allowance resets. `used`
// counts every invite created since the UTC month start regardless of status
// (matching enforcement in InvitesService.assertWithinMonthlyQuota), so the
// number shown can never disagree with the number enforced.
export interface InviteQuotaView {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string; // ISO — 00:00 UTC on the 1st of next month
}

export function toInviteQuotaView(
  limit: number,
  used: number,
  resetsAt: Date,
): InviteQuotaView {
  return {
    limit,
    used,
    remaining: Math.max(0, limit - used),
    resetsAt: resetsAt.toISOString(),
  };
}
