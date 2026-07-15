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
 * Directional block status between the actor and one member (`BlockStatus`
 * in social.api.ts). MUST carry nothing beyond these two booleans — no id,
 * no timestamp, no reason — so neither side can infer *who* blocked whom
 * beyond their own action.
 */
export interface BlockStatus {
  blocking: boolean;
  blockedBy: boolean;
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
