import { ForbiddenException } from '@nestjs/common';

/**
 * SEC-31: the reason code on a 403 from any staff route that opens or acts on
 * ONE report whose subject is the caller, or content the caller authored. The
 * admin console maps it to its own copy line.
 *
 * Kept in this dependency-free file so the staff evidence routes in
 * `reports/` (which `ModerationModule` imports, so they cannot inject
 * `ModerationService`) answer with the very same body as the queue routes.
 * `ModerationService.isReportAboutActor` is the full rule for any subject
 * type; the evidence routes each serve one subject type and match its author
 * directly.
 */
export const REPORT_ABOUT_ACTOR_CODE = 'REPORT_ABOUT_ACTOR';

/**
 * The refusal body for {@link REPORT_ABOUT_ACTOR_CODE}, shaped like the other
 * coded moderation refusals (`enforcement-refusals.ts`). The sentence says
 * what happens next: another staff member decides it. It names nothing about
 * the report, the reporter or the reason.
 */
export function reportAboutActorRefusal(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    error: 'Forbidden',
    code: REPORT_ABOUT_ACTOR_CODE,
    message:
      'This report is about you or something you posted, so another staff member will open and decide it.',
  });
}

/** The string at `key` on an evidence entry, or null. */
function stringField(entry: object, key: string): string | null {
  const value: unknown = Reflect.get(entry, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * SEC-31: the members a report's FILING-TIME snapshot names as behind its
 * subject, for when the live subject is gone and the shared resolver answers
 * no author (a photo the uploader deleted, a room removed from a housing
 * group, a message row purged after its hold). The snapshot is what the
 * report was about, so it decides who must not handle it.
 *
 *  - `photo-snapshot`: the uploader (`uploaderId`).
 *  - `group-listing-snapshot`: the poster (`posterId`).
 *  - `message-snapshot`: the sender (`senderId`).
 *  - `housing-snapshot`: the lister (`listerId`).
 *  - `community-gift-snapshot`: the sender (`senderId`).
 *  - a `group` snapshot (`kind`): the group's owner (`ownerId`).
 *  - a `mailbox_identity` snapshot (`kind`): everyone staffing the mailbox
 *    (`staffUserIds`).
 *
 * Read field by field off untyped `jsonb`, so a malformed entry contributes
 * nobody and never throws.
 */
export function snapshotSubjectUserIds(
  evidence: unknown[] | null | undefined,
): string[] {
  const userIds: string[] = [];
  for (const entry of evidence ?? []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const type = stringField(entry, 'type');
    const kind = stringField(entry, 'kind');
    const fieldByType: Record<string, string> = {
      'photo-snapshot': 'uploaderId',
      'group-listing-snapshot': 'posterId',
      'message-snapshot': 'senderId',
      'housing-snapshot': 'listerId',
      'community-gift-snapshot': 'senderId',
    };
    const field = type ? fieldByType[type] : undefined;
    if (field) {
      const userId = stringField(entry, field);
      if (userId) userIds.push(userId);
    }
    if (kind === 'group') {
      const ownerId = stringField(entry, 'ownerId');
      if (ownerId) userIds.push(ownerId);
    }
    if (kind === 'mailbox_identity') {
      const staffUserIds: unknown = Reflect.get(entry, 'staffUserIds');
      if (Array.isArray(staffUserIds)) {
        for (const staffUserId of staffUserIds) {
          if (typeof staffUserId === 'string') userIds.push(staffUserId);
        }
      }
    }
  }
  return userIds;
}

/**
 * SEC-31: the author-or-snapshot half of the "is this report about them"
 * rule, shared by every staff read path. `authorUserId` is the subject
 * resolver's live author; only when it found none (the content is gone) does
 * the filing-time snapshot decide. Compared case-insensitively, since ids
 * from `jsonb` and from uuid columns can differ in case.
 */
export function isSubjectBySnapshotOrAuthor(
  authorUserId: string | null | undefined,
  evidence: unknown[] | null | undefined,
  actorId: string,
): boolean {
  const normalizedActorId = actorId.toLowerCase();
  if (authorUserId) return authorUserId.toLowerCase() === normalizedActorId;
  return snapshotSubjectUserIds(evidence).some(
    (userId) => userId.toLowerCase() === normalizedActorId,
  );
}
