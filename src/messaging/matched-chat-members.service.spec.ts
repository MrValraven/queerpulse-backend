import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Repository } from 'typeorm';
import { ReportSubjectType } from '../reports/entities/report.entity';
import { ReportsService } from '../reports/reports.service';
import { SocialService } from '../social/social.service';
import { User, UserStatus } from '../users/entities/user.entity';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation } from './entities/conversation.entity';
import { MatchedChatMembersService } from './matched-chat-members.service';
import { matchedChatMemberKey } from './matched-member-key';
import { MessagingCoreService } from './messaging-core.service';

/**
 * PRD-423 (opaque member keys): a matched chat's member actions take the
 * per-chat key and resolve it inside that one conversation.
 */

const CHAT = 'chat-1';
const CALLER = 'user-caller';
const ANA = 'user-ana';

function build(options: {
  isGoTogetherChat: boolean;
  seats: string[];
  avatarUrl?: string | null;
  photoVisible?: boolean;
  isSuspended?: boolean;
}) {
  const core = {
    requireParticipant: jest.fn().mockResolvedValue({ userId: CALLER }),
  };
  const conversations = {
    findOne: jest.fn().mockResolvedValue({
      id: CHAT,
      isGoTogetherChat: options.isGoTogetherChat,
      eventMatchGroupId: null,
    }),
  };
  const participants = {
    find: jest
      .fn()
      .mockResolvedValue(options.seats.map((userId) => ({ userId }))),
    manager: {
      findOne: jest.fn(
        (
          entity: unknown,
          { where }: { where: { userId?: string; id?: string } },
        ) =>
          Promise.resolve(
            entity === User
              ? {
                  id: where.id,
                  status: options.isSuspended
                    ? UserStatus.Suspended
                    : UserStatus.Active,
                }
              : {
                  userId: where.userId,
                  slug: `${where.userId}-slug`,
                  avatarUrl: options.avatarUrl ?? null,
                  photoVisible: options.photoVisible ?? true,
                },
          ),
      ),
    },
  };
  const social = { blockMember: jest.fn().mockResolvedValue({}) };
  const reports = {
    create: jest.fn((_reporterId: string, input: { subjectId: string }) =>
      Promise.resolve({
        id: 'report-1',
        subjectType: ReportSubjectType.Member,
        subjectId: input.subjectId,
        reasonCode: 'harassment',
        severity: 'high',
        status: 'open',
        createdAt: '2026-10-06T10:00:00.000Z',
        slaDueAt: '2026-10-07T10:00:00.000Z',
        acknowledgement: 'Thanks',
      }),
    ),
  };
  const service = new MatchedChatMembersService(
    conversations as unknown as Repository<Conversation>,
    participants as unknown as Repository<ConversationParticipant>,
    core as unknown as MessagingCoreService,
    social as unknown as SocialService,
    reports as unknown as ReportsService,
  );
  return { service, core, social, reports };
}

describe('MatchedChatMembersService', () => {
  const anaKey = matchedChatMemberKey(CHAT, ANA);

  it('blocks the member behind a key through the ordinary block, naming nobody back', async () => {
    const { service, core, social } = build({
      isGoTogetherChat: true,
      seats: [CALLER, ANA],
    });

    await expect(service.blockMember(CHAT, CALLER, anaKey)).resolves.toEqual({
      blocking: true,
    });
    expect(core.requireParticipant).toHaveBeenCalledWith(CHAT, CALLER);
    expect(social.blockMember).toHaveBeenCalledWith(
      CALLER,
      `${ANA}-slug`,
      undefined,
      { matchedConversationId: CHAT },
    );
  });

  it('reports the member behind a key as a member subject, leaving the subject out of the answer', async () => {
    const { service, reports } = build({
      isGoTogetherChat: true,
      seats: [CALLER, ANA],
    });

    const filed = await service.reportMember(CHAT, CALLER, anaKey, {
      reasonCode: 'harassment',
      detail: 'Kept messaging after I asked them to stop',
    } as never);

    expect(reports.create).toHaveBeenCalledWith(
      CALLER,
      expect.objectContaining({
        subjectType: ReportSubjectType.Member,
        subjectId: ANA,
      }),
    );
    expect(filed).not.toHaveProperty('subjectId');
  });

  it('refuses a key minted for another chat', async () => {
    const { service, social } = build({
      isGoTogetherChat: true,
      seats: [CALLER, ANA],
    });

    await expect(
      service.blockMember(CHAT, CALLER, matchedChatMemberKey('chat-2', ANA)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(social.blockMember).not.toHaveBeenCalled();
  });

  it('refuses any key in a conversation that is not a matched chat', async () => {
    const { service } = build({
      isGoTogetherChat: false,
      seats: [CALLER, ANA],
    });

    await expect(
      service.blockMember(CHAT, CALLER, anaKey),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses the caller's own key", async () => {
    const { service } = build({
      isGoTogetherChat: true,
      seats: [CALLER, ANA],
    });

    await expect(
      service.blockMember(CHAT, CALLER, matchedChatMemberKey(CHAT, CALLER)),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  describe('resolveAvatar (I4)', () => {
    it("hands the route a seated member's stored avatar, the caller's own key included", async () => {
      const { service } = build({
        isGoTogetherChat: true,
        seats: [CALLER, ANA],
        avatarUrl: 'https://photos.example.com/ana.jpg',
      });

      await expect(
        service.resolveAvatar(CHAT, CALLER, anaKey),
      ).resolves.toEqual({ externalUrl: 'https://photos.example.com/ana.jpg' });
      await expect(
        service.resolveAvatar(CHAT, CALLER, matchedChatMemberKey(CHAT, CALLER)),
      ).resolves.toEqual({ externalUrl: 'https://photos.example.com/ana.jpg' });
    });

    it('answers the same 404 an unknown key gets for a caller with no seat', async () => {
      const { service, core } = build({
        isGoTogetherChat: true,
        seats: [ANA],
        avatarUrl: 'https://photos.example.com/ana.jpg',
      });
      core.requireParticipant.mockRejectedValue(
        new ForbiddenException('You are not a participant'),
      );

      await expect(
        service.resolveAvatar(CHAT, CALLER, anaKey),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('answers 404 for a hidden photo, a suspended member and a key from another chat', async () => {
      const hidden = build({
        isGoTogetherChat: true,
        seats: [CALLER, ANA],
        avatarUrl: 'https://photos.example.com/ana.jpg',
        photoVisible: false,
      });
      const suspended = build({
        isGoTogetherChat: true,
        seats: [CALLER, ANA],
        avatarUrl: 'https://photos.example.com/ana.jpg',
        isSuspended: true,
      });

      await expect(
        hidden.service.resolveAvatar(CHAT, CALLER, anaKey),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        suspended.service.resolveAvatar(CHAT, CALLER, anaKey),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        hidden.service.resolveAvatar(
          CHAT,
          CALLER,
          matchedChatMemberKey('chat-2', ANA),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
