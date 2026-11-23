import {
  captureCommunityGiftForReport,
  COMMUNITY_GIFT_REPORT_SQL,
} from './community-gift-report';

const FILED_AT = new Date('2026-11-21T00:00:00.000Z');

describe('captureCommunityGiftForReport', () => {
  it('snapshots the gift for its recipient', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'g1',
          community_id: 'c1',
          gift_key: 'heart',
          note: 'see you',
          sender_id: 'u9',
          sent_at: new Date('2026-11-20T10:00:00.000Z'),
        },
      ]),
    };

    expect(
      await captureCommunityGiftForReport(manager, 'g1', 'u2', FILED_AT),
    ).toEqual({
      type: 'community-gift-snapshot',
      giftId: 'g1',
      communityId: 'c1',
      giftKey: 'heart',
      note: 'see you',
      senderId: 'u9',
      sentAt: '2026-11-20T10:00:00.000Z',
      snapshotAt: '2026-11-21T00:00:00.000Z',
    });
    expect(manager.query).toHaveBeenCalledWith(COMMUNITY_GIFT_REPORT_SQL, [
      'g1',
      'u2',
    ]);
  });

  it('keeps a null note and a null sender as null', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'g2',
          community_id: 'c1',
          gift_key: 'star',
          note: null,
          sender_id: null,
          sent_at: '2026-11-19T08:30:00.000Z',
        },
      ]),
    };

    const snapshot = await captureCommunityGiftForReport(
      manager,
      'g2',
      'u2',
      FILED_AT,
    );

    expect(snapshot).toEqual(
      expect.objectContaining({
        note: null,
        senderId: null,
        sentAt: '2026-11-19T08:30:00.000Z',
      }),
    );
  });

  it('answers null when no gift is addressed to the filer', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };

    await expect(
      captureCommunityGiftForReport(manager, 'g1', 'u3', FILED_AT),
    ).resolves.toBeNull();
    expect(manager.query).toHaveBeenCalledWith(COMMUNITY_GIFT_REPORT_SQL, [
      'g1',
      'u3',
    ]);
  });

  it('reads the gift by id and recipient whether or not it was removed', () => {
    expect(COMMUNITY_GIFT_REPORT_SQL).toBe(
      'SELECT "id", "community_id", "gift_key", "note", "sender_id", "sent_at" FROM "community_gifts" WHERE "id" = $1 AND "recipient_id" = $2',
    );
    expect(COMMUNITY_GIFT_REPORT_SQL).not.toContain('removed_at');
  });
});
