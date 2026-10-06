import { MemberRef } from '../common/member-ref';
import type { RestoredConnectionStatus } from '../connections/entities/connection.entity';
import type { IdentityBlock } from '../identities/entities/identity-block.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import type { IdentityDescription } from '../identities/identities.service';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';

// A member ref that couldn't be resolved (e.g. the profile was deleted
// between the block/mute being placed and the row being read back) — mirrors
// `ConnectionMemberView`'s `?? ''` fallback in `connection-response.ts` so a
// dangling reference never crashes serialization.
const EMPTY_MEMBER_REF: MemberRef = {
  slug: '',
  firstName: '',
  lastName: '',
  pronouns: null,
  avatarUrl: null,
};

/** `BlockDTO` (social.api.ts) — a member the actor has blocked. */
export interface BlockDTO {
  id: string;
  member: MemberRef;
  createdAt: Date;
  reason?: string;
  /** PRD-423: true for a block placed from inside a matched Go together
   *  chat. `member` then carries the first name and pronouns alone, the
   *  only name the blocker ever had, and the row is
   *  unblocked by its `id` (`DELETE /blocks/by-id/:id`). Absent on every
   *  ordinary block. */
  isMatchedChatBlock?: true;
}

/** `MuteDTO` (social.api.ts) — a member the actor has muted. */
export interface MuteDTO {
  id: string;
  member: MemberRef;
  createdAt: Date;
}

/**
 * Block status between the actor and one member (`BlockStatus` in
 * social.api.ts). Carries ONLY the actor's own action — no id, no timestamp,
 * no reason, and deliberately no `blockedBy`.
 *
 * `blockedBy` used to be here, and it told a member the moment the other
 * person blocked them — the classic escalation trigger a block exists to
 * avoid, and pollable across the whole directory via `GET /blocks/:slug`. It
 * also contradicted `ConnectionsService.request`, which goes out of its way to
 * make an inbound block INDISTINGUISHABLE from a pending request ("Don't
 * disclose that the *other* member blocked you"). The two paths now agree: a
 * member learns only what they themselves did, and everything else is the same
 * uniform 403/409 whether they were blocked or not.
 */
export interface BlockStatus {
  blocking: boolean;
}

/**
 * `DELETE /blocks/:slug` body (PRD-363). `restoredStatus` is what the unblock
 * put back: `accepted` or `pending` when the pair is exactly where it was
 * before the block, `none` when there was nothing to restore.
 */
export interface UnblockResult {
  restoredStatus: RestoredConnectionStatus;
}

export function toBlockDTO(
  row: Block,
  member: MemberRef | undefined,
): BlockDTO {
  if (row.matchedConversationId) {
    // PRD-423: the first name and pronouns the matched chat showed, and
    // nothing that leads back to the person.
    return {
      id: row.id,
      member: {
        ...EMPTY_MEMBER_REF,
        firstName: member?.firstName.trim() ?? '',
        pronouns: member?.pronouns ?? null,
      },
      createdAt: row.createdAt,
      reason: row.reason ?? undefined,
      isMatchedChatBlock: true,
    };
  }
  return {
    id: row.id,
    member: member ?? EMPTY_MEMBER_REF,
    createdAt: row.createdAt,
    reason: row.reason ?? undefined,
  };
}

export function toMuteDTO(row: Mute, member: MemberRef | undefined): MuteDTO {
  return {
    id: row.id,
    member: member ?? EMPTY_MEMBER_REF,
    createdAt: row.createdAt,
  };
}

/**
 * Task 14: a business, persona or company the actor has blocked
 * (`GET /identity-blocks`, `POST /identity-blocks/:identityId`). The
 * display fields come from `IdentitiesService.describeIdentities`; an
 * identity whose owner row has since gone reads with null display fields.
 */
export interface IdentityBlockDTO {
  id: string;
  identity: {
    id: string;
    kind: IdentityKind | null;
    displayName: string | null;
    handle: string | null;
    avatarUrl: string | null;
  };
  createdAt: Date;
}

export function toIdentityBlockDTO(
  row: IdentityBlock,
  kind: IdentityKind | undefined,
  description: IdentityDescription | undefined,
): IdentityBlockDTO {
  return {
    id: row.id,
    identity: {
      id: row.identityId ?? row.retiredIdentityId ?? '',
      kind: kind ?? null,
      displayName: description?.displayName ?? null,
      handle: description?.handle ?? null,
      avatarUrl: description?.avatarUrl ?? null,
    },
    createdAt: row.createdAt,
  };
}

/**
 * ENG-447: a block carried across a persona going unlinked, as the member's
 * Blocked list shows it: under the retired identity's id (the one they
 * blocked, and the one unblock takes) and the named persona's name from the
 * snapshot. No handle and no avatar: both would be the pseudonymous
 * persona's, and nothing on this row may lead to it.
 */
export function toCarriedIdentityBlockDTO(
  row: IdentityBlock,
): IdentityBlockDTO {
  return {
    id: row.id,
    identity: {
      id: row.retiredIdentityId ?? '',
      kind: IdentityKind.Subprofile,
      displayName: row.blockedNameSnapshot,
      handle: null,
      avatarUrl: null,
    },
    createdAt: row.createdAt,
  };
}
