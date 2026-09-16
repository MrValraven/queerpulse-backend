import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull, Not } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PreferencesService } from '../preferences/preferences.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { ConversationsService } from './conversations.service';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-268: spec coverage for the per-participant preference setters
 * (setMuted/setFavorite/setArchived/setMarkedUnread/setDraft) and the
 * setPinned cap. ENG-247/248 rewrote all six; this file is their first spec
 * coverage. See T9c-brief.md for the verbatim source notes this file was
 * written against.
 *
 * Scoped to `ConversationsService` alone: `MessagingCoreService` is provided
 * as a bare `requireParticipant` mock rather than a real instance wired to a
 * participants repository, since `requireParticipant`'s own behaviour is
 * already exercised elsewhere (e.g. `markRead`/`clearConversation` in
 * `messaging.service.spec.ts`). What is under test here is each setter's own
 * contract: exactly one targeted `update` with only the column(s) it owns, no
 * `save`, and setPinned's transaction/lock/cap.
 */
describe('ConversationsService preferences (ENG-268)', () => {
  let service: ConversationsService;
  let core: { requireParticipant: jest.Mock };
  let participants: { update: jest.Mock; save: jest.Mock };
  let manager: { query: jest.Mock; count: jest.Mock; update: jest.Mock };
  let dataSource: { transaction: jest.Mock };

  function buildParticipant(
    overrides: Partial<ConversationParticipant> = {},
  ): ConversationParticipant {
    return {
      id: 'p1',
      conversationId: 'c1',
      userId: 'me',
      pinnedAt: null,
      ...overrides,
    } as ConversationParticipant;
  }

  beforeEach(async () => {
    core = { requireParticipant: jest.fn() };
    participants = {
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      save: jest.fn(),
    };
    // `setPinned`'s fresh-pin branch runs inside the transaction: a per-member
    // advisory lock (`manager.query`), then a count of this caller's OTHER
    // pinned rows (`manager.count`), by default 0, then the write
    // (`manager.update`).
    manager = {
      query: jest.fn().mockResolvedValue(undefined),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    dataSource = {
      transaction: jest
        .fn()
        .mockImplementation(
          (
            runInTransaction: (
              transactionManager: typeof manager,
            ) => Promise<unknown>,
          ) => runInTransaction(manager),
        ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationsService,
        { provide: getRepositoryToken(Conversation), useValue: {} },
        {
          provide: getRepositoryToken(ConversationParticipant),
          useValue: participants,
        },
        { provide: getRepositoryToken(Profile), useValue: {} },
        { provide: MessagingCoreService, useValue: core },
        { provide: BlockFilterService, useValue: {} },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: DataSource, useValue: dataSource },
        {
          provide: MediaCropService,
          useValue: { getMany: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: ConnectionsService, useValue: {} },
        // PRD-364: unused by the setters this file exercises (setMuted etc.) —
        // only `markRead`/`listConversations`/`toConversationResponse` read it.
        { provide: PreferencesService, useValue: {} },
      ],
    }).compile();
    service = module.get(ConversationsService);
  });

  describe('setMuted', () => {
    it('rejects a non-participant before writing anything', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setMuted('c1', 'ghost', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('muting without mutedUntil writes only `muted`, leaving any existing expiry untouched', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const result = await service.setMuted('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { muted: true },
      );
      expect(participants.save).not.toHaveBeenCalled();
    });

    it('muting with a future mutedUntil writes both columns', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await service.setMuted('c1', 'me', true, future);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { muted: true, mutedUntil: new Date(future) },
      );
    });

    it('muting with mutedUntil: null is explicit "Always" (forever)', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setMuted('c1', 'me', true, null);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { muted: true, mutedUntil: null },
      );
    });

    it('unmuting always clears mutedUntil, regardless of what was passed', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      await service.setMuted('c1', 'me', false, future);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { muted: false, mutedUntil: null },
      );
    });

    it('rejects a mutedUntil already in the past', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const past = new Date(Date.now() - 1000).toISOString();
      await expect(
        service.setMuted('c1', 'me', true, past),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('rejects a mutedUntil beyond the maximum mute duration', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const tooFar = new Date(
        Date.now() + 401 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await expect(
        service.setMuted('c1', 'me', true, tooFar),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('rejects an unparsable mutedUntil', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await expect(
        service.setMuted('c1', 'me', true, 'not-a-date'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(participants.update).not.toHaveBeenCalled();
    });
  });

  describe('setFavorite', () => {
    it('rejects a non-participant', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setFavorite('c1', 'ghost', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('favoriting writes only `favoritedAt`, stamped with the app clock', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const result = await service.setFavorite('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { favoritedAt: expect.any(Date) as Date },
      );
      expect(participants.save).not.toHaveBeenCalled();
    });

    it('unfavoriting writes only `favoritedAt: null`', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setFavorite('c1', 'me', false);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { favoritedAt: null },
      );
    });
  });

  describe('setArchived', () => {
    it('rejects a non-participant', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setArchived('c1', 'ghost', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('archiving writes only `archivedAt`, stamped with the app clock', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const result = await service.setArchived('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { archivedAt: expect.any(Date) as Date },
      );
      expect(participants.save).not.toHaveBeenCalled();
    });

    it('unarchiving writes only `archivedAt: null`', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setArchived('c1', 'me', false);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { archivedAt: null },
      );
    });
  });

  describe('setMarkedUnread', () => {
    it('rejects a non-participant', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setMarkedUnread('c1', 'ghost', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('marking unread writes only `markedUnreadAt`, stamped with the app clock', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const result = await service.setMarkedUnread('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { markedUnreadAt: expect.any(Date) as Date },
      );
      expect(participants.save).not.toHaveBeenCalled();
    });

    it('clearing the flag writes only `markedUnreadAt: null`', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setMarkedUnread('c1', 'me', false);
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { markedUnreadAt: null },
      );
    });
  });

  describe('setDraft', () => {
    it('rejects a non-participant', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setDraft('c1', 'ghost', 'hi'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
    });

    it('a non-empty draft is written verbatim', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      const result = await service.setDraft('c1', 'me', 'unsent text');
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { draft: 'unsent text' },
      );
      expect(participants.save).not.toHaveBeenCalled();
    });

    it('an empty string clears the stored draft to null', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setDraft('c1', 'me', '');
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { draft: null },
      );
    });

    // The source's "empty text drops the key" rule checks only
    // `draft.length > 0`; it does no trimming. A whitespace-only draft has
    // length > 0, so it is stored as-is. Documenting this explicitly since
    // the brief's notes did not spell out the exact rule.
    it('a whitespace-only draft is NOT trimmed or treated as empty', async () => {
      core.requireParticipant.mockResolvedValueOnce(buildParticipant());
      await service.setDraft('c1', 'me', '   ');
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { draft: '   ' },
      );
    });
  });

  describe('setPinned', () => {
    it('rejects a non-participant before writing anything', async () => {
      core.requireParticipant.mockRejectedValueOnce(
        new ForbiddenException('You are not a participant'),
      );
      await expect(
        service.setPinned('c1', 'ghost', true),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(participants.update).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('unpinning updates the row directly, with no transaction', async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: new Date('2026-01-01T00:00:00Z') }),
      );
      const result = await service.setPinned('c1', 'me', false);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { pinnedAt: null },
      );
      expect(participants.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('re-pinning an already-pinned thread updates the row directly, with no transaction', async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: new Date('2026-01-01T00:00:00Z') }),
      );
      const result = await service.setPinned('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(participants.update).toHaveBeenCalledWith(
        { conversationId: 'c1', userId: 'me' },
        { pinnedAt: expect.any(Date) as Date },
      );
      expect(participants.save).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('a fresh pin takes a per-member advisory lock before counting or writing', async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: null }),
      );
      manager.count.mockResolvedValueOnce(0);
      const result = await service.setPinned('c1', 'me', true);
      expect(result).toEqual({ ok: true });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        ['conversation_pin:me'],
      );
      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { conversationId: 'c1', userId: 'me' },
        { pinnedAt: expect.any(Date) as Date },
      );
      // The fresh-pin branch writes exclusively through the transaction's
      // own manager.
      expect(participants.update).not.toHaveBeenCalled();
    });

    it("counts only this caller's OTHER pinned rows, excluding the target conversation's own row", async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: null }),
      );
      manager.count.mockResolvedValueOnce(0);
      await service.setPinned('c1', 'me', true);
      expect(manager.count).toHaveBeenCalledWith(ConversationParticipant, {
        where: {
          userId: 'me',
          pinnedAt: Not(IsNull()),
          conversationId: Not('c1'),
        },
      });
    });

    it('allows a fresh pin with exactly 2 other pinned conversations', async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: null }),
      );
      manager.count.mockResolvedValueOnce(2);
      await expect(service.setPinned('c1', 'me', true)).resolves.toEqual({
        ok: true,
      });
      expect(manager.update).toHaveBeenCalledWith(
        ConversationParticipant,
        { conversationId: 'c1', userId: 'me' },
        { pinnedAt: expect.any(Date) as Date },
      );
    });

    it('throws ConflictException with the exact cap message at 3 other pinned conversations', async () => {
      core.requireParticipant.mockResolvedValueOnce(
        buildParticipant({ pinnedAt: null }),
      );
      manager.count.mockResolvedValueOnce(3);
      const rejection = service.setPinned('c1', 'me', true);
      await expect(rejection).rejects.toBeInstanceOf(ConflictException);
      await expect(rejection).rejects.toMatchObject({
        message: 'You can pin up to 3 chats.',
      });
      expect(manager.update).not.toHaveBeenCalled();
    });
  });
});
