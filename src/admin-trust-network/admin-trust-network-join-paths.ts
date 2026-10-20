import { In, Repository } from 'typeorm';
import { Invite } from '../membership/entities/invite.entity';
import {
  PlatformJoinRequest,
  PlatformJoinRequestStatus,
} from '../membership/entities/join-request.entity';
import { Profile } from '../users/entities/profile.entity';
import type { AccountKind } from './admin-trust-network-assessment';
import type { TrustJoinPathDTO } from './admin-trust-network-response';

export interface JoinPathRepositories {
  invites: Repository<Invite>;
  joinRequests: Repository<PlatformJoinRequest>;
  profiles: Repository<Profile>;
}

export interface JoinPathMemberInput {
  userId: string;
  invitedByUserId: string | null;
  accountKind: AccountKind;
  joinedAt: Date;
}

/** Account kinds whose trust comes from the role, so a missing inviter reads
 *  as a founding account. */
const FOUNDING_ACCOUNT_KINDS: ReadonlySet<AccountKind> = new Set<AccountKind>([
  'founder',
  'staff',
  'system',
]);

interface ResolvedJoinPath {
  kind: TrustJoinPathDTO['kind'];
  byUserId: string | null;
  at: Date | null;
}

/**
 * How each member arrived, in precedence order:
 * 1. `founder`: account kind founder, staff or system with no inviter.
 * 2. `application`: an invite they redeemed was minted by an approved
 *    platform join request; by = the reviewer, at = `reviewed_at`.
 * 3. `invite`: they have an inviter; by = the inviter, at = invite `used_at`.
 * 4. `unknown`: no join record.
 *
 * Three queries total (invites, approved requests, "by" profiles), however
 * many members are passed in.
 */
export async function loadJoinPaths(
  repos: JoinPathRepositories,
  members: JoinPathMemberInput[],
): Promise<Map<string, TrustJoinPathDTO>> {
  const joinPathByUserId = new Map<string, TrustJoinPathDTO>();
  if (members.length === 0) return joinPathByUserId;

  const memberUserIds = members.map((member) => member.userId);
  const redeemedInvites = await repos.invites.find({
    where: { acceptedBy: In(memberUserIds) },
    select: ['id', 'acceptedBy', 'usedAt'],
  });
  const redeemedInviteIds = redeemedInvites.map((invite) => invite.id);
  const approvedRequests = redeemedInviteIds.length
    ? await repos.joinRequests.find({
        where: {
          inviteId: In(redeemedInviteIds),
          status: PlatformJoinRequestStatus.Approved,
        },
        select: ['id', 'inviteId', 'reviewedBy', 'reviewedAt'],
      })
    : [];
  const approvedRequestByInviteId = new Map(
    approvedRequests.map((request) => [request.inviteId, request]),
  );

  const invitesByAcceptedUserId = new Map<string, Invite[]>();
  for (const invite of redeemedInvites) {
    if (invite.acceptedBy === null) continue;
    const list = invitesByAcceptedUserId.get(invite.acceptedBy) ?? [];
    list.push(invite);
    invitesByAcceptedUserId.set(invite.acceptedBy, list);
  }

  const resolvedByUserId = new Map<string, ResolvedJoinPath>();
  for (const member of members) {
    resolvedByUserId.set(
      member.userId,
      resolveJoinPath(
        member,
        invitesByAcceptedUserId.get(member.userId) ?? [],
        approvedRequestByInviteId,
      ),
    );
  }

  const byUserIds = [
    ...new Set(
      [...resolvedByUserId.values()]
        .map((resolved) => resolved.byUserId)
        .filter((userId): userId is string => userId !== null),
    ),
  ];
  const byProfiles = byUserIds.length
    ? await repos.profiles.find({
        where: { userId: In(byUserIds) },
        select: ['userId', 'slug', 'firstName', 'lastName'],
      })
    : [];
  const byProfileByUserId = new Map(
    byProfiles.map((profile) => [profile.userId, profile]),
  );

  for (const [userId, resolved] of resolvedByUserId) {
    const byProfile =
      resolved.byUserId === null
        ? undefined
        : byProfileByUserId.get(resolved.byUserId);
    joinPathByUserId.set(userId, {
      kind: resolved.kind,
      bySlug: byProfile?.slug ?? null,
      byName: byProfile
        ? `${byProfile.firstName} ${byProfile.lastName}`.trim()
        : null,
      at: resolved.at ? resolved.at.toISOString() : null,
    });
  }
  return joinPathByUserId;
}

function resolveJoinPath(
  member: JoinPathMemberInput,
  redeemedInvites: Invite[],
  approvedRequestByInviteId: Map<string | null, PlatformJoinRequest>,
): ResolvedJoinPath {
  if (
    member.invitedByUserId === null &&
    FOUNDING_ACCOUNT_KINDS.has(member.accountKind)
  ) {
    return { kind: 'founder', byUserId: null, at: member.joinedAt };
  }

  for (const invite of redeemedInvites) {
    const approvedRequest = approvedRequestByInviteId.get(invite.id);
    if (approvedRequest) {
      return {
        kind: 'application',
        byUserId: approvedRequest.reviewedBy,
        at: approvedRequest.reviewedAt ?? invite.usedAt ?? member.joinedAt,
      };
    }
  }

  if (member.invitedByUserId !== null) {
    const earliestUsedAt = redeemedInvites
      .map((invite) => invite.usedAt)
      .filter((usedAt): usedAt is Date => usedAt !== null)
      .sort((first, second) => first.getTime() - second.getTime())[0];
    return {
      kind: 'invite',
      byUserId: member.invitedByUserId,
      at: earliestUsedAt ?? member.joinedAt,
    };
  }

  return { kind: 'unknown', byUserId: null, at: null };
}
