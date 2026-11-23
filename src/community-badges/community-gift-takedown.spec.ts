import { EntityManager } from 'typeorm';
import { CommunityGovernanceLog } from '../communities/entities/community-governance-log.entity';
import {
  REMOVE_GIFT_ON_TAKEDOWN_SQL,
  SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL,
  removeCommunityGiftOnTakedown,
  scrubGiftNoteFromRecipientNotification,
} from './community-gift-takedown';

const GIFT_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('removeCommunityGiftOnTakedown', () => {
  let manager: { query: jest.Mock; getRepository: jest.Mock };
  let governanceRepository: { create: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    // `create` echoes its input so the saved value is the written entry.
    governanceRepository = {
      create: jest.fn((entry: unknown) => entry),
      save: jest.fn().mockResolvedValue(undefined),
    };
    manager = {
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn().mockReturnValue(governanceRepository),
    };
  });

  const run = (subjectType: string, subjectId: string) =>
    removeCommunityGiftOnTakedown(
      manager as unknown as EntityManager,
      subjectType,
      subjectId,
      'mod-1',
    );

  it('returns at once for every other subject type', async () => {
    await run('post', GIFT_ID);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('removes the gift and logs a platform removal that names neither actor nor target and carries no note', async () => {
    manager.query.mockResolvedValueOnce([
      {
        id: GIFT_ID,
        community_id: 'c1',
        recipient_id: 'u2',
        gift_key: 'heart',
      },
    ]);
    await run('community_gift', GIFT_ID);
    expect(manager.query).toHaveBeenCalledWith(REMOVE_GIFT_ON_TAKEDOWN_SQL, [
      GIFT_ID,
      'mod-1',
    ]);
    expect(manager.getRepository).toHaveBeenCalledWith(CommunityGovernanceLog);
    // The recipient is the only one who can report a gift, so the entry names
    // no target and staff cannot tell who filed.
    expect(governanceRepository.save).toHaveBeenCalledWith({
      communityId: 'c1',
      actorUserId: null,
      action: 'gift_removed',
      targetUserId: null,
      metadata: { giftId: GIFT_ID, giftKey: 'heart', adminOverride: true },
    });
  });

  it('scrubs the note from the recipient notification on the same manager', async () => {
    manager.query.mockResolvedValueOnce([
      {
        id: GIFT_ID,
        community_id: 'c1',
        recipient_id: 'u2',
        gift_key: 'heart',
      },
    ]);
    await run('community_gift', GIFT_ID);
    expect(manager.query).toHaveBeenCalledTimes(2);
    expect(manager.query).toHaveBeenLastCalledWith(
      SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL,
      [GIFT_ID, 'u2'],
    );
  });

  it('logs nothing and scrubs nothing for a gift already removed', async () => {
    manager.query.mockResolvedValue([]);
    await run('community_gift', GIFT_ID);
    expect(governanceRepository.save).not.toHaveBeenCalled();
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it('never sends a malformed id to the database', async () => {
    await run('community_gift', 'gift-1');
    expect(manager.query).not.toHaveBeenCalled();
  });
});

describe('scrubGiftNoteFromRecipientNotification', () => {
  it('drops only the note key from the gift notification of the recipient', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await scrubGiftNoteFromRecipientNotification(manager, GIFT_ID, 'u2');
    expect(manager.query).toHaveBeenCalledWith(
      SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL,
      [GIFT_ID, 'u2'],
    );
    expect(SCRUB_GIFT_NOTE_FROM_NOTIFICATION_SQL).toBe(
      `UPDATE "notifications" SET "payload" = "payload" - 'note' WHERE "type" = 'community_gift_received' AND "user_id" = $2 AND "payload" ->> 'giftId' = $1 AND "payload" ? 'note'`,
    );
  });
});
