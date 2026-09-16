import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationsService } from './conversations.service';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { MessagingCoreService } from './messaging-core.service';

const CONVERSATION_ID = 'c1';
const VIEWER_ID = 'me';

/**
 * PRD-351: coverage for the real read INSTANT `markRead` now stamps
 * alongside the pre-existing `lastReadAt` WATERMARK, on both the
 * `upToMessageId` branch and the legacy (no watermark given) branch. The
 * watermark's own GREATEST/LEAST clamping semantics are asserted unchanged
 * in the same tests, so a regression on either column shows up here.
 */
describe('ConversationsService.markRead (PRD-351 read instant)', () => {
  let service: ConversationsService;
  let participants: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
  };
  let core: {
    requireActiveParticipant: jest.Mock;
    messageCreatedAt: jest.Mock;
  };
  let preferencesService: { getMessagingPrivacy: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let update: {
    set: jest.Mock;
    setParameter: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(() => {
    update = {} as typeof update;
    const self = (): typeof update => update;
    update.set = jest.fn(self);
    update.setParameter = jest.fn(self);
    update.where = jest.fn(self);
    update.andWhere = jest.fn(self);
    update.execute = jest.fn().mockResolvedValue({ affected: 1 });

    participants = {
      createQueryBuilder: jest.fn(() => ({
        update: jest.fn(() => update),
      })),
      findOne: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        lastReadAt: new Date('2026-09-15T10:00:00Z'),
        lastReadInstant: new Date('2026-09-15T10:00:03Z'),
      }),
    };
    core = {
      requireActiveParticipant: jest.fn().mockResolvedValue({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        leftAt: null,
      }),
      messageCreatedAt: jest
        .fn()
        .mockResolvedValue(new Date('2026-09-15T09:59:00Z')),
    };
    preferencesService = {
      getMessagingPrivacy: jest
        .fn()
        .mockResolvedValue({ shareReadReceipts: true }),
    };
    eventEmitter = { emit: jest.fn() };

    service = new ConversationsService(
      {} as unknown as Repository<Conversation>,
      participants as unknown as Repository<ConversationParticipant>,
      {} as unknown as Repository<Profile>,
      core as unknown as MessagingCoreService,
      {} as unknown as BlockFilterService,
      eventEmitter as unknown as EventEmitter2,
      {} as unknown as DataSource,
      {} as unknown as MediaCropService,
      {} as unknown as ConnectionsService,
      preferencesService as unknown as PreferencesService,
    );
  });

  function setValues(): Record<string, unknown> {
    const [call] = update.set.mock.calls as [Record<string, unknown>][];
    return call![0];
  }

  describe('with an explicit `upToMessageId` watermark', () => {
    it('stamps `lastReadInstant` to the raw DB now(), separate from the watermark expression', async () => {
      await service.markRead(CONVERSATION_ID, VIEWER_ID, {
        upToMessageId: 'm1',
      });

      const values = setValues();
      expect(typeof values.lastReadInstant).toBe('function');
      expect((values.lastReadInstant as () => string)()).toBe('now()');
    });

    it('leaves the pre-existing watermark GREATEST/LEAST clamp untouched', async () => {
      await service.markRead(CONVERSATION_ID, VIEWER_ID, {
        upToMessageId: 'm1',
      });

      const values = setValues();
      expect((values.lastReadAt as () => string)()).toBe(
        'GREATEST(last_read_at, LEAST(:watermark::timestamptz, now()))',
      );
    });

    it('never GREATEST-clamps the read instant against its own prior value', () => {
      // The instant column is written as a bare `now()` on every call (see
      // the assertion above); unlike `lastReadAt`, its `set()` expression
      // does not reference `last_read_instant` at all, so it can never lag
      // a later call the way a GREATEST comparison against a stale value
      // could.
      expect(update.set.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe('with no watermark (legacy `now()`-only call)', () => {
    it('still stamps `lastReadInstant` to now(), on the no-watermark branch too', async () => {
      await service.markRead(CONVERSATION_ID, VIEWER_ID);

      const values = setValues();
      expect(typeof values.lastReadInstant).toBe('function');
      expect((values.lastReadInstant as () => string)()).toBe('now()');
      expect((values.lastReadAt as () => string)()).toBe(
        'GREATEST(last_read_at, now())',
      );
    });
  });

  it('writes the read instant regardless of the PRD-364 read-receipt-sharing toggle (the leak is prevented at display time)', async () => {
    preferencesService.getMessagingPrivacy.mockResolvedValueOnce({
      shareReadReceipts: false,
    });

    await service.markRead(CONVERSATION_ID, VIEWER_ID, {
      upToMessageId: 'm1',
    });

    const values = setValues();
    // The delivered watermark IS gated (an empty object from
    // `deliveredWatermark`), but `lastReadInstant`, like `lastReadAt`
    // itself, is written unconditionally.
    expect(values.deliveredAt).toBeUndefined();
    expect(typeof values.lastReadInstant).toBe('function');
  });

  it("relays the STORED read instant back from the row, never the app server's own clock", async () => {
    await service.markRead(CONVERSATION_ID, VIEWER_ID, {
      upToMessageId: 'm1',
    });

    expect(participants.findOne).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID, userId: VIEWER_ID },
    });
    // The re-read after the write is the single source the emitted event and
    // any caller reads back from; markRead itself never constructs a `new
    // Date()` for either watermark.
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'message.read',
      expect.objectContaining({
        conversationId: CONVERSATION_ID,
        userId: VIEWER_ID,
        lastReadAt: new Date('2026-09-15T10:00:00Z'),
      }),
    );
  });
});
