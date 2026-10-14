import { DataSource } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SavedKind } from '../saved/entities/saved-item.entity';
import { SavedService } from '../saved/saved.service';
import {
  ClaimedReleaseRow,
  RELEASE_ALERT_CLAIM_SQL,
  RELEASE_ALERT_RECIPIENTS_SQL,
  RELEASE_LATER_DROP_REMINDERS_SQL,
  RELEASE_REMINDERS_DISCARD_SQL,
  StudioReleaseAlertsListener,
} from './studio-release-alerts.listener';

const RELEASE_ID = 'd1000000-0000-4000-8000-000000000001';
const PERSONA_ID = 'd2000000-0000-4000-8000-000000000001';
const OWNER_ID = 'd3000000-0000-4000-8000-000000000001';

const REMINDER_HOLDER = 'd5000000-0000-4000-8000-000000000001';

const claimedRow: ClaimedReleaseRow = {
  release_id: RELEASE_ID,
  release_title: 'Lisbon at four',
  release_type: 'mix',
  subprofile_id: PERSONA_ID,
  subprofile_name: 'Night Shift',
  subprofile_slug_or_handle: 'night-shift',
  owner_user_id: OWNER_ID,
  reminder_user_ids: [],
};

const followerIds = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `d4000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

describe('StudioReleaseAlertsListener', () => {
  let query: jest.Mock;
  let createForRecipients: jest.Mock;
  let saveForMembersIfMissing: jest.Mock;
  let listener: StudioReleaseAlertsListener;

  // `followers` answer as followers; `reminderHolders` as reminder holders
  // (a member can be both). `laterDropRows` answer the later-drop consume.
  const respond = (
    claimRows: ClaimedReleaseRow[],
    followers: string[],
    reminderHolders: string[] = [],
    laterDropRows: ClaimedReleaseRow[] = [],
  ) => {
    query.mockImplementation((sql: string) => {
      if (sql === RELEASE_ALERT_CLAIM_SQL) {
        return Promise.resolve(claimRows);
      }
      if (sql === RELEASE_LATER_DROP_REMINDERS_SQL) {
        return Promise.resolve(laterDropRows);
      }
      if (sql === RELEASE_ALERT_RECIPIENTS_SQL) {
        const recipientIds = [...new Set([...followers, ...reminderHolders])];
        return Promise.resolve(
          recipientIds.map((recipientId) => ({
            recipient_id: recipientId,
            is_reminder_holder: reminderHolders.includes(recipientId),
          })),
        );
      }
      return Promise.resolve([]);
    });
  };

  beforeEach(() => {
    query = jest.fn();
    createForRecipients = jest.fn().mockResolvedValue([]);
    saveForMembersIfMissing = jest.fn().mockResolvedValue([]);
    listener = new StudioReleaseAlertsListener(
      { query } as unknown as DataSource,
      { createForRecipients } as unknown as NotificationsService,
      { saveForMembersIfMissing } as unknown as SavedService,
    );
  });

  it('claims the release before it reads a single follower', async () => {
    respond([claimedRow], followerIds(2));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query.mock.calls[0]).toEqual([
      RELEASE_ALERT_CLAIM_SQL,
      [RELEASE_ID],
    ]);
    expect(query.mock.calls[1]?.[0]).toBe(RELEASE_ALERT_RECIPIENTS_SQL);
  });

  it('discards the reminders and sends nothing when neither the claim nor a later drop finds the release', async () => {
    respond([], followerIds(2));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]).toEqual([
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [RELEASE_ID, 5000],
    ]);
    expect(query.mock.calls[2]).toEqual([
      RELEASE_REMINDERS_DISCARD_SQL,
      [RELEASE_ID],
    ]);
    expect(createForRecipients).not.toHaveBeenCalled();
    expect(saveForMembersIfMissing).not.toHaveBeenCalled();
  });

  it('asks for granted followers and reminder holders minus the creator and co-owners, each up to 5000', async () => {
    respond(
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER] }],
      followerIds(1),
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query.mock.calls[1]?.[1]).toEqual([
      PERSONA_ID,
      OWNER_ID,
      5000,
      [REMINDER_HOLDER],
    ]);
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('"studio_access_grants"');
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('"subprofile_members"');
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain(
      `"follower"."follower_id" <> $2`,
    );
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain(
      `"reminder_holder"."user_id" <> $2`,
    );
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('unnest($4::uuid[])');
    expect(RELEASE_ALERT_RECIPIENTS_SQL.match(/LIMIT \$3/g)?.length).toBe(2);
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toContain('GROUP BY');
    expect(RELEASE_ALERT_RECIPIENTS_SQL).toMatch(
      /ORDER BY "candidate"\."user_id"$/,
    );
  });

  it('leaves out a reminder holder blocked either way with the persona creator', () => {
    const reminderHoldersSql = RELEASE_ALERT_RECIPIENTS_SQL.slice(
      RELEASE_ALERT_RECIPIENTS_SQL.indexOf('"eligible_reminder_holders" AS ('),
      RELEASE_ALERT_RECIPIENTS_SQL.indexOf('SELECT "candidate"'),
    );
    expect(reminderHoldersSql).toContain('NOT EXISTS');
    expect(reminderHoldersSql).toContain('FROM "blocks" "creator_block"');
    expect(reminderHoldersSql).toContain(
      `("creator_block"."blocker_id" = $2 AND "creator_block"."blocked_id" = "reminder_holder"."user_id")`,
    );
    expect(reminderHoldersSql).toContain(
      `("creator_block"."blocked_id" = $2 AND "creator_block"."blocker_id" = "reminder_holder"."user_id")`,
    );
  });

  it('tells followers in chunks of 500, filtered under the persona owner', async () => {
    const followers = followerIds(1200);
    respond([claimedRow], followers);

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(createForRecipients).toHaveBeenCalledTimes(3);
    const chunks = createForRecipients.mock.calls.map(
      ([recipientIds]) => recipientIds as string[],
    );
    expect(chunks.map((chunk) => chunk.length)).toEqual([500, 500, 200]);
    expect(chunks.flat()).toEqual(followers);
    for (const call of createForRecipients.mock.calls) {
      expect(call[1]).toBe(NotificationType.StudioReleasePublished);
      expect(call[3]).toBe(OWNER_ID);
    }
  });

  it('puts the persona and the release on the payload and no owner id', async () => {
    respond([claimedRow], followerIds(1));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      subprofileName: 'Night Shift',
      subprofileSlugOrHandle: 'night-shift',
      subprofileId: PERSONA_ID,
      releaseId: RELEASE_ID,
      releaseTitle: 'Lisbon at four',
      releaseType: 'mix',
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
  });

  it('links a persona without a handle by its slug', async () => {
    respond(
      [{ ...claimedRow, subprofile_slug_or_handle: 'night-shift-slug' }],
      followerIds(1),
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload.subprofileSlugOrHandle).toBe('night-shift-slug');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `COALESCE("persona"."handle", "persona"."slug") AS "subprofile_slug_or_handle"`,
    );
  });

  it('names a persona with a blank display name by its link token', () => {
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `NULLIF(btrim("persona"."display_name"), '')`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toMatch(
      /COALESCE\(\s*NULLIF\(btrim\("persona"\."display_name"\), ''\),\s*"persona"\."handle",\s*"persona"\."slug"\s*\) AS "subprofile_name"/,
    );
  });

  it('sends nothing when no follower qualifies', async () => {
    respond([claimedRow], []);

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('claims only a published release of a listenable persona that was never alerted, consuming its reminders', () => {
    expect(RELEASE_ALERT_CLAIM_SQL).toMatch(/^WITH "claimed" AS \(/);
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"release"."followers_notified_at" IS NULL`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `"persona"."visibility" = 'open'`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('content_moderation');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain(
      `DELETE FROM "studio_release_reminders" AS "reminder"`,
    );
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('USING "claimed"');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('AS "reminder_user_ids"');
    expect(RELEASE_ALERT_CLAIM_SQL).toContain('FROM "claimed"');
    expect(RELEASE_REMINDERS_DISCARD_SQL).toContain(
      `"release"."status" = 'published'`,
    );
  });

  it('never throws back at the publish when the fan-out fails', async () => {
    respond([claimedRow], followerIds(1));
    createForRecipients.mockRejectedValue(new Error('pool exhausted'));

    await expect(
      listener.handleReleasePublished({ releaseId: RELEASE_ID }),
    ).resolves.toBeUndefined();
  });

  // Studio v3: reminder holders hear once and find the release saved.
  it('alerts a reminder holder who does not follow the persona', async () => {
    respond(
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER] }],
      [],
      [REMINDER_HOLDER],
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(createForRecipients).toHaveBeenCalledTimes(1);
    expect(createForRecipients.mock.calls[0]?.[0]).toEqual([REMINDER_HOLDER]);
  });

  it('pre-saves the release for reminder holders only', async () => {
    const followers = followerIds(2);
    respond(
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER, followers[0]!] }],
      followers,
      [REMINDER_HOLDER, followers[0]!],
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(saveForMembersIfMissing).toHaveBeenCalledTimes(1);
    const [memberIds, kind, subjectId, snapshot] = saveForMembersIfMissing.mock
      .calls[0] as [string[], SavedKind, string, object];
    expect([...memberIds].sort()).toEqual(
      [REMINDER_HOLDER, followers[0]!].sort(),
    );
    expect(kind).toBe(SavedKind.StudioRelease);
    expect(subjectId).toBe(RELEASE_ID);
    expect(snapshot).toEqual({
      title: 'Lisbon at four',
      href: `/studio/album?id=${RELEASE_ID}`,
      meta: 'Night Shift',
    });
  });

  it('pre-saves nothing when no reminder holder qualifies', async () => {
    respond([claimedRow], followerIds(3));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(saveForMembersIfMissing).not.toHaveBeenCalled();
  });

  it('still pre-saves when the fan-out fails', async () => {
    respond(
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER] }],
      [],
      [REMINDER_HOLDER],
    );
    createForRecipients.mockRejectedValue(new Error('pool exhausted'));

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(saveForMembersIfMissing).toHaveBeenCalledTimes(1);
  });

  // Studio v3 later drop: followers heard at the first publish, so only the
  // reminder holders hear now.
  it('alerts and pre-saves reminder holders on a later drop when followers were already alerted', async () => {
    respond(
      [],
      followerIds(2),
      [],
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER] }],
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query.mock.calls[1]).toEqual([
      RELEASE_LATER_DROP_REMINDERS_SQL,
      [RELEASE_ID, 5000],
    ]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(createForRecipients).toHaveBeenCalledTimes(1);
    expect(createForRecipients.mock.calls[0]?.[0]).toEqual([REMINDER_HOLDER]);
    expect(createForRecipients.mock.calls[0]?.[1]).toBe(
      NotificationType.StudioReleasePublished,
    );
    expect(createForRecipients.mock.calls[0]?.[3]).toBe(OWNER_ID);
    expect(saveForMembersIfMissing).toHaveBeenCalledWith(
      [REMINDER_HOLDER],
      SavedKind.StudioRelease,
      RELEASE_ID,
      {
        title: 'Lisbon at four',
        href: `/studio/album?id=${RELEASE_ID}`,
        meta: 'Night Shift',
      },
    );
  });

  it('sends nothing to followers on that later drop', async () => {
    const followers = followerIds(2);
    respond(
      [],
      followers,
      [],
      [{ ...claimedRow, reminder_user_ids: [REMINDER_HOLDER] }],
    );

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    const sqlRun = query.mock.calls.map(([sql]) => sql as string);
    expect(sqlRun).not.toContain(RELEASE_ALERT_RECIPIENTS_SQL);
    const alerted = createForRecipients.mock.calls.flatMap(
      ([recipientIds]) => recipientIds as string[],
    );
    expect(alerted).toEqual([REMINDER_HOLDER]);
    for (const followerId of followers) {
      expect(alerted).not.toContain(followerId);
    }
  });

  it('alerts nobody when a later drop consumed only reminder holders who do not qualify', async () => {
    respond([], [], [], [claimedRow]);

    await listener.handleReleasePublished({ releaseId: RELEASE_ID });

    expect(query).toHaveBeenCalledTimes(2);
    expect(createForRecipients).not.toHaveBeenCalled();
    expect(saveForMembersIfMissing).not.toHaveBeenCalled();
  });

  it('consumes a later drop only for a published release of a listenable persona, filtered like the reminder holders', () => {
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toMatch(/^WITH "dropped" AS \(/);
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `"release"."status" = 'published'`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `"persona"."visibility" = 'open'`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain('content_moderation');
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `DELETE FROM "studio_release_reminders" AS "reminder"`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain('USING "dropped"');
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      '"studio_access_grants"',
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain('"subprofile_members"');
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `"reminder_holder"."user_id" <> "dropped"."owner_user_id"`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `("creator_block"."blocker_id" = "dropped"."owner_user_id" AND "creator_block"."blocked_id" = "reminder_holder"."user_id")`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      `("creator_block"."blocked_id" = "dropped"."owner_user_id" AND "creator_block"."blocker_id" = "reminder_holder"."user_id")`,
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain('LIMIT $2');
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).toContain(
      'WHERE EXISTS (SELECT 1 FROM "consumed")',
    );
    expect(RELEASE_LATER_DROP_REMINDERS_SQL).not.toContain(
      'followers_notified_at',
    );
  });
});
