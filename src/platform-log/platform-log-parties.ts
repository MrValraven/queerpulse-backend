import type { MemberRef } from '../common/member-ref';
import type {
  PlatformLogEntryDTO,
  PlatformLogPartyDTO,
} from './dto/platform-log-entry.dto';
import type { PlatformLogRawEntry } from './platform-log.types';

type KnownPartyKind = 'staff' | 'member';

function displayName(memberRef: MemberRef): string {
  return `${memberRef.firstName} ${memberRef.lastName}`.trim();
}

function erasedParty(): PlatformLogPartyDTO {
  return { userId: null, name: '', kind: 'erased' };
}

function resolveKnownParty(
  userId: string | null,
  fallbackName: string | null,
  kind: KnownPartyKind,
  names: ReadonlyMap<string, MemberRef>,
): PlatformLogPartyDTO {
  const memberRef = userId ? names.get(userId) : undefined;
  if (userId && memberRef)
    return { userId, name: displayName(memberRef), kind };
  if (fallbackName) return { userId: null, name: fallbackName, kind };
  return erasedParty();
}

function resolveActor(
  entry: PlatformLogRawEntry,
  names: ReadonlyMap<string, MemberRef>,
): PlatformLogPartyDTO {
  if (entry.actorKind === 'anonymous') {
    return { userId: null, name: '', kind: 'anonymous' };
  }
  if (entry.actorKind === 'system') {
    return {
      userId: null,
      name: entry.actorFallbackName ?? '',
      kind: 'system',
    };
  }
  return resolveKnownParty(
    entry.actorUserId,
    entry.actorFallbackName,
    entry.actorKind,
    names,
  );
}

function resolveTarget(
  entry: PlatformLogRawEntry,
  names: ReadonlyMap<string, MemberRef>,
): PlatformLogPartyDTO | null {
  if (entry.targetUserId === null && entry.targetFallbackName === null) {
    return null;
  }
  return resolveKnownParty(
    entry.targetUserId,
    entry.targetFallbackName,
    'member',
    names,
  );
}

export function toPlatformLogEntryDto(
  entry: PlatformLogRawEntry,
  names: ReadonlyMap<string, MemberRef>,
): PlatformLogEntryDTO {
  const isMemberRow =
    entry.actorKind === 'member' || entry.actorKind === 'anonymous';
  return {
    id: `${entry.sourceKey}:${entry.rowId}`,
    occurredAt: `${entry.occurredAtExact.slice(0, 23)}Z`,
    category: entry.category,
    kind: entry.kind,
    actor: resolveActor(entry, names),
    target: resolveTarget(entry, names),
    subject: entry.subject,
    params: entry.params,
    note: isMemberRow ? null : entry.note,
  };
}

/** Every id the page needs a name for. Anonymous actors are never looked up. */
export function userIdsToResolve(
  entries: readonly PlatformLogRawEntry[],
): string[] {
  const userIds = new Set<string>();
  for (const entry of entries) {
    if (entry.actorUserId && entry.actorKind !== 'anonymous') {
      userIds.add(entry.actorUserId);
    }
    if (entry.targetUserId) userIds.add(entry.targetUserId);
  }
  return [...userIds];
}
