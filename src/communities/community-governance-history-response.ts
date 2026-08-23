import { MemberRef } from '../common/member-ref';
import {
  CommunityGovernanceLog,
  GovernanceLogAction,
} from './entities/community-governance-log.entity';
import { RosterRole } from './entities/community-member.entity';

/**
 * One changed setting on a `settings_changed` entry, as an ordered list rather
 * than the raw `Record<string, {from,to}>` the log stores, so a client renders
 * "who changed what" in a stable order without iterating an open map.
 */
export interface CommunityGovernanceSettingChangeDTO {
  field: string;
  from: unknown;
  to: unknown;
}

/**
 * The per-action detail a community's OWN staff may see, hand-picked key by
 * key out of the log's free-form `metadata` jsonb.
 *
 * WHY THIS IS AN ALLOWLIST AND MUST STAY ONE
 *
 * `community_governance_log.metadata` is an unbounded `jsonb` written by a
 * dozen call sites across four modules (communities, admin-communities,
 * membership-cards, and whatever is added next). The admin reader
 * (`AdminGovernanceLogEntryDTO`) passes that column straight through, which is
 * right for platform staff and wrong here: a passthrough means the DEFAULT for
 * any key a future `log()` call site invents is "community staff can read it",
 * so a report id, a triage note, or an internal moderation signal would ship to
 * every community owner the day someone wrote it, with no code change on this
 * file to notice. Reading key by key inverts that default. A new key is
 * platform-staff-only until somebody deliberately adds it below.
 *
 * WHAT IS DELIBERATELY IN
 *
 * `changedSettings` includes `accessTier` transitions in full. A community's
 * staff are entitled to know that their room went from private to public and
 * who did it: that is the single most consequential setting they own, and it is
 * exactly the question this endpoint exists to answer. Every field the
 * member-side `PATCH /communities/:slug` can write is already readable by this
 * same audience on `CommunityDetailDTO`, so the diff of those fields discloses
 * nothing new. It only attributes it.
 *
 * `reason` likewise carries the moderator's own ban note, which the same
 * owner/co-owner/mod audience already reads on `CommunityBanDTO.reason`, and
 * the freeze trigger (`manual`, `report_pileup`, `emergency_report`), which
 * every viewer already reads as `CommunityDetailDTO.frozenReason`.
 *
 * WHAT IS DELIBERATELY OUT
 *
 * 1. Raw user ids (`previousOwnerId`, `fromOwnerId`, `bannedByUserId`,
 *    `frozenByUserId`). No community-facing response in this module emits a raw
 *    uuid; people travel as `MemberRef`. On the member-side ownership transfer
 *    `fromOwnerId` is the actor anyway, so `actor` already carries it.
 * 2. Everything on a platform-staff action. See `isPlatformAction` below.
 * 3. Cosmetic or internal card fields (`skin`, `codeVersion`). They answer no
 *    governance question, and an audit panel is not the place to grow them.
 */
export interface CommunityGovernanceLogDetailsDTO {
  /** `role_changed`: the roster role the member held, and the one they hold now. */
  fromRole?: RosterRole;
  toRole?: RosterRole;
  /** `member_removed`: true when the member left of their own accord rather
   *  than being removed by a moderator. */
  isSelfRemoval?: boolean;
  /** `member_banned` / `ban_lifted`: the moderator's ban note.
   *  `frozen`: which trigger froze the community.
   *  `owner_auto_promoted`: why the promotion happened. */
  reason?: string;
  /** `frozen`: the short public line the moderator wrote about a manual pause. */
  note?: string;
  /** `ban_lifted`: when the ban being lifted was originally placed, ISO 8601. */
  bannedAt?: string;
  /** The card actions: which card was suspended, revoked, reinstated or reissued. */
  cardSerial?: string;
  /** `settings_changed`: the field-by-field diff, in the order it was written. */
  changedSettings?: CommunityGovernanceSettingChangeDTO[];
}

/**
 * One row of `GET /communities/:slug/governance-log`, the community-facing
 * read of `community_governance_log` for that community's own owner, co-owners
 * and moderators.
 *
 * `actor` and `target` are the compact `MemberRef` every other community
 * response embeds. No `User` row, no `Profile` row and no raw uuid leaves
 * through this route. Either side can be `null`, and the entry still stands: the action had no single target
 * (archive, freeze), had no human actor (an automatic freeze, the owner-erasure
 * auto-promotion), or the person has since erased their account (both FKs are
 * `ON DELETE SET NULL` precisely so the trail outlives them). Nothing is
 * dropped for a missing name, because an audit trail that loses rows when
 * someone leaves stops being an audit trail. A client renders a null side as
 * "a former member" or "automatically", using `action` and `details` for the
 * rest of the sentence.
 *
 * `isPlatformAction` is true when a platform administrator took this action
 * against the community from the admin console (the log's
 * `metadata.adminOverride`). Such an entry keeps `actor: null` and an empty
 * `details` on purpose. The community's staff are entitled to know that the
 * change came from the platform and not from one of them, which is the
 * confusion this endpoint exists to end. They are not entitled to the name of
 * the platform moderator who acted on a community that was just moderated, nor
 * to the platform-side settings that patch can carry (`isFeatured`,
 * `requiresSecondVouch`, `autoFreezeOnReports` appear nowhere in this
 * community's own surfaces). Those stay with platform staff on
 * `GET /admin/communities/:slug/governance-log`, which still exposes the whole
 * payload.
 */
export interface CommunityGovernanceLogEntryDTO {
  id: string;
  action: GovernanceLogAction;
  actor: MemberRef | null;
  target: MemberRef | null;
  isPlatformAction: boolean;
  details: CommunityGovernanceLogDetailsDTO;
  createdAt: string;
}

/** True only for the exact `{ adminOverride: true }` marker the admin-side
 *  `log()` call sites write. Anything else, including a truthy non-boolean, is
 *  treated as not a platform action so a malformed value can never suppress an
 *  ordinary entry's actor. */
function isAdminOverride(metadata: Record<string, unknown> | null): boolean {
  return metadata?.adminOverride === true;
}

function readString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readBoolean(
  metadata: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function readRosterRole(
  metadata: Record<string, unknown>,
  key: string,
): RosterRole | undefined {
  const value = metadata[key];
  return typeof value === 'string' &&
    (Object.values(RosterRole) as string[]).includes(value)
    ? (value as RosterRole)
    : undefined;
}

/**
 * The `settings_changed` diff, read defensively: the column is jsonb, so the
 * shape is a convention rather than a guarantee, and a row written before the
 * current diff shape existed must degrade to "no diff" instead of throwing
 * inside a list response.
 */
function readChangedSettings(
  metadata: Record<string, unknown>,
): CommunityGovernanceSettingChangeDTO[] | undefined {
  const changes = metadata.changes;
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes))
    return undefined;

  const changedSettings: CommunityGovernanceSettingChangeDTO[] = [];
  for (const [field, change] of Object.entries(
    changes as Record<string, unknown>,
  )) {
    if (typeof change !== 'object' || change === null) continue;
    const { from, to } = change as { from?: unknown; to?: unknown };
    changedSettings.push({ field, from: from ?? null, to: to ?? null });
  }
  return changedSettings.length ? changedSettings : undefined;
}

/**
 * The allowlist itself. Every key this community's staff may read is named
 * here, once. `banReason` and `reason` fold into the same `reason` field
 * because they are the same thing written under two names by two call sites
 * (`CommunitiesService.removeMember` and `CommunityBansService.liftBan`), and a
 * client should not have to know which.
 */
function toDetails(
  metadata: Record<string, unknown> | null,
): CommunityGovernanceLogDetailsDTO {
  if (!metadata || isAdminOverride(metadata)) return {};

  const details: CommunityGovernanceLogDetailsDTO = {};
  const fromRole = readRosterRole(metadata, 'fromRole');
  const toRole = readRosterRole(metadata, 'toRole');
  const isSelfRemoval = readBoolean(metadata, 'removedBySelf');
  const reason =
    readString(metadata, 'reason') ?? readString(metadata, 'banReason');
  const note = readString(metadata, 'note');
  const bannedAt = readString(metadata, 'bannedAt');
  const cardSerial = readString(metadata, 'serial');
  const changedSettings = readChangedSettings(metadata);

  if (fromRole !== undefined) details.fromRole = fromRole;
  if (toRole !== undefined) details.toRole = toRole;
  if (isSelfRemoval !== undefined) details.isSelfRemoval = isSelfRemoval;
  if (reason !== undefined) details.reason = reason;
  if (note !== undefined) details.note = note;
  if (bannedAt !== undefined) details.bannedAt = bannedAt;
  if (cardSerial !== undefined) details.cardSerial = cardSerial;
  if (changedSettings !== undefined) details.changedSettings = changedSettings;
  return details;
}

/**
 * Hand-maps one log row to its community-facing shape (this repo has no global
 * serializer, so every response is mapped explicitly).
 *
 * `memberRefs` is the batched `MemberLookup.byUserIds` map for the whole page.
 * A `userId` missing from it is an erased or non-active account, which maps to
 * `null` rather than dropping the entry.
 */
export function toCommunityGovernanceLogEntry(
  entry: CommunityGovernanceLog,
  memberRefs: Map<string, MemberRef>,
): CommunityGovernanceLogEntryDTO {
  const isPlatformAction = isAdminOverride(entry.metadata);
  return {
    id: entry.id,
    action: entry.action,
    actor:
      isPlatformAction || !entry.actorUserId
        ? null
        : (memberRefs.get(entry.actorUserId) ?? null),
    target: entry.targetUserId
      ? (memberRefs.get(entry.targetUserId) ?? null)
      : null,
    isPlatformAction,
    details: toDetails(entry.metadata),
    createdAt: entry.createdAt.toISOString(),
  };
}
