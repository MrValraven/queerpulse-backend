import { MemberRef } from '../common/member-ref';
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

export function toBlockDTO(
  row: Block,
  member: MemberRef | undefined,
): BlockDTO {
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
