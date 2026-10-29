import type { Repository } from 'typeorm';
import type { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';

export const MUSIC_EVENT_AUDIT_ACTIONS = {
  created: 'music_event_created',
  updated: 'music_event_updated',
  cancelled: 'music_event_cancelled',
  lineupChanged: 'music_event_lineup_changed',
  announcementPosted: 'music_event_announcement_posted',
  guestRemoved: 'music_event_guest_removed',
  guestBarred: 'music_event_guest_barred',
  guestBarLifted: 'music_event_guest_bar_lifted',
  waitlistPromoted: 'music_event_waitlist_promoted',
  invitesSent: 'music_event_invites_sent',
  inviteDecided: 'music_event_invite_decided',
  cohostAdded: 'music_event_cohost_added',
  cohostRemoved: 'music_event_cohost_removed',
  goTogetherChanged: 'music_event_go_together_changed',
  guestsExported: 'music_event_guests_exported',
} as const;

export type MusicEventAuditAction =
  (typeof MUSIC_EVENT_AUDIT_ACTIONS)[keyof typeof MUSIC_EVENT_AUDIT_ACTIONS];

export interface MusicEventAuditEntry {
  actorId: string;
  action: MusicEventAuditAction;
  eventSlug: string;
  eventTitle: string;
  targetUserId?: string | null;
  targetName?: string | null;
  /** Callers never pass a bar reason or an announcement body here. */
  detail?: string;
}

/**
 * One immutable row in the shared moderation trail, so an organizer action on
 * a music event is visible in the same audit feed as every other action, and
 * does not live only in the event's own tables.
 *
 * `targetUserId` + `targetName` name the member acted upon when there is one
 * (a removed guest, an added co-host); with no member targeted, `targetName`
 * carries the event title so the audit subject column names the event.
 * `reportId` stays null because an organizer action is not a response to any
 * particular report. The note opens with the event slug, so every row names
 * the event it happened on.
 */
export function buildMusicEventAuditRow(
  entry: MusicEventAuditEntry,
): Partial<ModAuditLog> {
  const hasTarget = entry.targetUserId != null;
  const hasDetail = entry.detail !== undefined && entry.detail.length > 0;
  return {
    reportId: null,
    actorId: entry.actorId,
    action: entry.action,
    targetUserId: entry.targetUserId ?? null,
    targetName: hasTarget ? (entry.targetName ?? null) : entry.eventTitle,
    reasonCode: null,
    note: hasDetail ? `${entry.eventSlug}: ${entry.detail}` : entry.eventSlug,
    duration: null,
  };
}

export async function writeMusicEventAudit(
  repository: Repository<ModAuditLog>,
  entry: MusicEventAuditEntry,
): Promise<void> {
  await repository.save(repository.create(buildMusicEventAuditRow(entry)));
}
