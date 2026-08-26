import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_CATEGORY,
  categoryForType,
} from './notification-preferences';
import { NotificationType } from './entities/notification.entity';
import {
  isMinuteWithinWindow,
  isWithinQuietHours,
  localMinuteOfDay,
} from './notification-quiet-hours';
import { bundleKeyFor } from './notification-bundling';

describe('notification preference classification', () => {
  it('never classifies a type as both mutable and always-delivered', () => {
    const mutable = new Set(Object.keys(NOTIFICATION_TYPE_CATEGORY));
    const clashing = ALWAYS_DELIVERED_NOTIFICATION_TYPES.filter((type) =>
      mutable.has(type),
    );
    expect(clashing).toEqual([]);
  });

  it('reports no category for an always-delivered type', () => {
    for (const type of ALWAYS_DELIVERED_NOTIFICATION_TYPES) {
      expect(categoryForType(type)).toBeNull();
    }
  });

  it('puts the noisy community types behind a member switch', () => {
    // The exact gap SOC-10 named: a member in five busy communities could not
    // turn these down short of leaving.
    for (const type of [
      NotificationType.CommunityNewPost,
      NotificationType.CommunityAnnouncement,
      NotificationType.CommunityResourceAdded,
      NotificationType.CommunityReply,
      NotificationType.TopicNewPost,
      NotificationType.XpLevelUp,
      NotificationType.BadgeEarned,
      NotificationType.PersonaFollowed,
    ]) {
      expect(categoryForType(type)).not.toBeNull();
    }
  });

  it('keeps safety and account outcomes unmutable', () => {
    for (const type of [
      NotificationType.ModerationOutcome,
      NotificationType.CommunityBanned,
      NotificationType.SecurityNewSignIn,
      NotificationType.AccountDeletionFinalWarning,
      NotificationType.EventCancelled,
    ]) {
      expect(categoryForType(type)).toBeNull();
    }
  });
});

describe('quiet-hours arithmetic', () => {
  it('treats the window as half-open so the end minute is audible', () => {
    // 22:00 to 08:00.
    expect(isMinuteWithinWindow(22 * 60, 22 * 60, 8 * 60)).toBe(true);
    expect(isMinuteWithinWindow(8 * 60, 22 * 60, 8 * 60)).toBe(false);
  });

  it('handles a window that wraps midnight', () => {
    expect(isMinuteWithinWindow(3 * 60, 22 * 60, 8 * 60)).toBe(true);
    expect(isMinuteWithinWindow(12 * 60, 22 * 60, 8 * 60)).toBe(false);
  });

  it('handles a window inside one day', () => {
    expect(isMinuteWithinWindow(14 * 60, 13 * 60, 15 * 60)).toBe(true);
    expect(isMinuteWithinWindow(16 * 60, 13 * 60, 15 * 60)).toBe(false);
  });

  it('treats an empty window as never quiet rather than always quiet', () => {
    // A mis-set pair must not silence a member permanently.
    expect(isMinuteWithinWindow(9 * 60, 9 * 60, 9 * 60)).toBe(false);
  });

  it('reads the clock in the member time zone', () => {
    // 02:30 UTC is 22:30 the previous evening in New York.
    const instant = new Date('2026-01-15T02:30:00.000Z');
    expect(localMinuteOfDay(instant, 'UTC')).toBe(2 * 60 + 30);
    expect(localMinuteOfDay(instant, 'America/New_York')).toBe(21 * 60 + 30);
  });

  it('degrades an unknown stored zone to UTC instead of throwing', () => {
    const instant = new Date('2026-01-15T02:30:00.000Z');
    expect(localMinuteOfDay(instant, 'Mars/Olympus_Mons')).toBe(2 * 60 + 30);
  });

  it('is never quiet while the member has quiet hours switched off', () => {
    expect(
      isWithinQuietHours(
        {
          isQuietHoursEnabled: false,
          quietHoursStartMinute: 22 * 60,
          quietHoursEndMinute: 8 * 60,
          timeZone: 'UTC',
        },
        new Date('2026-01-15T03:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('is quiet at 3am local for an enabled overnight window', () => {
    expect(
      isWithinQuietHours(
        {
          isQuietHoursEnabled: true,
          quietHoursStartMinute: 22 * 60,
          quietHoursEndMinute: 8 * 60,
          timeZone: 'Europe/Lisbon',
        },
        new Date('2026-01-15T03:00:00.000Z'),
      ),
    ).toBe(true);
  });
});

describe('bundle keys', () => {
  it('collapses replies onto their thread, not their actor', () => {
    const first = bundleKeyFor(NotificationType.ForumReply, {
      threadSlug: 'binders-in-lisbon',
      actorId: 'member-1',
    });
    const second = bundleKeyFor(NotificationType.ForumReply, {
      threadSlug: 'binders-in-lisbon',
      actorId: 'member-2',
    });
    expect(first).toBe(second);
    expect(first).not.toBeNull();
  });

  it('keeps different subjects apart', () => {
    expect(
      bundleKeyFor(NotificationType.ForumReply, { threadSlug: 'one' }),
    ).not.toBe(
      bundleKeyFor(NotificationType.ForumReply, { threadSlug: 'two' }),
    );
  });

  it('never bundles a mention', () => {
    expect(
      bundleKeyFor(NotificationType.Mention, { threadSlug: 'a-thread' }),
    ).toBeNull();
  });

  it('never bundles an always-delivered outcome', () => {
    expect(
      bundleKeyFor(NotificationType.ModerationOutcome, { reason: 'spam' }),
    ).toBeNull();
  });

  it('writes its own row when the subject field is missing', () => {
    expect(bundleKeyFor(NotificationType.ForumReply, {})).toBeNull();
  });
});
