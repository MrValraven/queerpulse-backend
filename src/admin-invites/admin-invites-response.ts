import { MemberRef } from '../common/member-ref';
import { Invite, InviteStatus } from '../membership/entities/invite.entity';
import {
  PublicInviteStatus,
  resolveInviteStatus,
} from '../membership/invite-response';

// Display-ready reference to the member on either side of an invite. Carries a
// single composed `name` (not raw first/last) so the admin UI can render it
// directly — mirroring how every other admin surface hands the client a `name`
// (see `admin-members-response`).
export interface AdminInvitePersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

/** Compose the display shape the admin UI expects from a resolved `MemberRef`. */
export function toAdminInvitePerson(
  ref: MemberRef | null,
): AdminInvitePersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

// One invite row on the platform-wide admin oversight surface. Hand-mapped from
// the entity — no raw columns leak. Unlike the member-facing `MyInviteView`, an
// admin row DOES carry the internal `id` and both member refs (inviter +
// invitee), because that is the whole point of oversight; it still never carries
// PII beyond the invitee `email` the inviter themselves typed.
export interface AdminInviteDTO {
  id: string;
  code: string;
  status: PublicInviteStatus;
  // The raw stored status, distinct from the resolved `status` above: a
  // `pending` row past its `expiresAt` resolves as 'expired' but is stored
  // 'pending' until swept. Exposed so an admin can tell a swept-expired invite
  // from a lapsed-but-unswept one.
  storedStatus: InviteStatus;
  email: string | null;
  // The inviter's personal message written at POST /invites (the "invite
  // message"), and their "why I'm inviting you" note (the "vouch message").
  // Both are optional free text the inviter typed; surfaced here for oversight.
  note: string | null;
  vouch: string | null;
  // The inviter's own label for the invite (who it is for). Seen only by the
  // inviter and admins.
  privateNote: string | null;
  // True for a member's own personal invite; false for a system-minted one
  // (join-request approval, genesis bootstrap).
  personal: boolean;
  createdAt: string;
  expiresAt: string | null;
  acceptedAt: string | null;
  inviter: AdminInvitePersonDTO | null;
  invitee: AdminInvitePersonDTO | null;
}

export interface AdminInvitesPageDTO {
  items: AdminInviteDTO[];
  total: number;
  page: number;
  pageSize: number;
}

// Why an invite was left alone by `POST /admin/invites/bulk`. `not_found` means
// no invite carries that id; the other four name the invite's RESOLVED status
// (`resolveInviteStatus`, with 'used' spelled `accepted` and 'valid' spelled
// `still_valid`), so the reason matches what the admin list shows for the row.
export type AdminInviteSkipReason =
  'not_found' | 'accepted' | 'revoked' | 'expired' | 'still_valid';

export interface AdminInviteBulkSkipDTO {
  id: string;
  // `null` when the reason is `not_found`, since there is no row to read it from.
  code: string | null;
  reason: AdminInviteSkipReason;
}

// Result of `POST /admin/invites/bulk`. `updated` holds the invites now in
// their new state, in the order the ids were sent, each in the same shape the
// single revoke and refresh routes return.
export interface AdminInvitesBulkResultDTO {
  updated: AdminInviteDTO[];
  skipped: AdminInviteBulkSkipDTO[];
}

// Result of `POST /admin/invites/refresh-expired`.
export interface AdminInvitesRefreshExpiredResultDTO {
  refreshedCount: number;
}

// One entry in the "filter by sender" list: every member who has minted at
// least one invite, with how many they sent. Powers the admin invite filter's
// dropdown so it can offer every inviter platform-wide, not only those on the
// pages already loaded. Keyed by `slug` (what the list query filters on, and
// what `PATCH /admin/members/:id/invite-quota` accepts too).
export interface AdminInviteInviterDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
  count: number;
  // This inviter's per-member monthly invite quota override
  // (`User.inviteMonthlyQuota`). `null` means no override — they use the
  // platform-wide `INVITE_MONTHLY_QUOTA` default. Surfaced here (not just on
  // the member detail view) so the admin invite-oversight page can show and
  // edit it inline, right next to who's actually sending invites.
  inviteMonthlyQuota: number | null;
}

// One member row in the admin "Invite quotas" list: their invite usage and the
// monthly limit enforcement actually applies to them.
export interface AdminInviteQuotaMemberDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
  // Invites created since the start of the current UTC calendar month, the
  // same window `InvitesService` counts against the limit.
  sentThisMonth: number;
  sentTotal: number;
  // The staff-set override (`User.inviteMonthlyQuota`), `null` when none.
  inviteMonthlyQuota: number | null;
  // `User.hasInviteAccess`. While false, `InvitesService` refuses every new
  // invite from this member (the admin "Invites paused" lever).
  hasInviteAccess: boolean;
  // The effective limit from `resolveMonthlyInviteLimit`: the override when
  // set, otherwise the base plus the level and ambassador bonuses.
  monthlyLimit: number;
}

// Result of `GET /admin/invites/quotas`.
export interface AdminInviteQuotaListDTO {
  // The configured base (`app.inviteMonthlyQuota`, from INVITE_MONTHLY_QUOTA).
  defaultMonthlyQuota: number;
  items: AdminInviteQuotaMemberDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminInviteDTO(
  invite: Invite,
  inviter: MemberRef | null,
  invitee: MemberRef | null,
  now: Date,
): AdminInviteDTO {
  return {
    id: invite.id,
    code: invite.code,
    status: resolveInviteStatus(invite, now),
    storedStatus: invite.status,
    email: invite.email ?? null,
    note: invite.note ?? null,
    vouch: invite.vouch ?? null,
    privateNote: invite.privateNote ?? null,
    personal: invite.personal,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    acceptedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    inviter: toAdminInvitePerson(inviter),
    invitee: toAdminInvitePerson(invitee),
  };
}
