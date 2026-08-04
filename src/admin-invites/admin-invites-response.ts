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
  note: string | null;
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
    personal: invite.personal,
    createdAt: invite.createdAt.toISOString(),
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    acceptedAt: invite.usedAt ? invite.usedAt.toISOString() : null,
    inviter: toAdminInvitePerson(inviter),
    invitee: toAdminInvitePerson(invitee),
  };
}
