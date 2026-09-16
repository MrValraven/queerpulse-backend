import { BadRequestException } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ConversationsController } from './messaging.controller';
import { ConversationMuteMode } from './entities/conversation-participant.entity';

/**
 * PRD-349: `PATCH /conversations/:id` must accept `{ muteMode }` alone
 * (without any other preference field) and dispatch it to
 * `MessagingService.setMuteMode`, never falling into the "Nothing to
 * update" 400 the way it did before `muteMode` was wired into the
 * dispatch/guard.
 */
describe('ConversationsController.update: muteMode dispatch (PRD-349)', () => {
  const user: CurrentUserData = {
    userId: 'user-1',
    email: 'user@example.com',
    status: 'active',
    role: 'member',
  };

  function buildController() {
    const messagingService = {
      setMuteMode: jest.fn().mockResolvedValue({
        ok: true,
        muteMode: ConversationMuteMode.MentionsOnly,
      }),
      updateGroup: jest.fn(),
      setMuted: jest.fn(),
      setPinned: jest.fn(),
      setFavorite: jest.fn(),
      setArchived: jest.fn(),
      setMarkedUnread: jest.fn(),
      setDraft: jest.fn(),
    };
    const conversationMediaService = {};
    const conversationsService = {};
    const controller = new ConversationsController(
      messagingService as never,
      conversationMediaService as never,
      conversationsService as never,
    );
    return { controller, messagingService };
  }

  it('dispatches a muteMode-only PATCH to setMuteMode without a 400', async () => {
    const { controller, messagingService } = buildController();
    const result = await controller.update('conv-1', user, {
      muteMode: ConversationMuteMode.MentionsOnly,
    });
    expect(messagingService.setMuteMode).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      ConversationMuteMode.MentionsOnly,
    );
    expect(result).toEqual({
      ok: true,
      muteMode: ConversationMuteMode.MentionsOnly,
    });
  });

  it('still 400s an empty body (no preference field at all)', async () => {
    const { controller } = buildController();
    await expect(controller.update('conv-1', user, {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('applies muted and muteMode together when both are provided, last result wins', async () => {
    const { controller, messagingService } = buildController();
    messagingService.setMuted.mockResolvedValue({ ok: true });
    const result = await controller.update('conv-1', user, {
      muted: true,
      muteMode: ConversationMuteMode.MentionsOnly,
    });
    expect(messagingService.setMuted).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      true,
      undefined,
    );
    expect(messagingService.setMuteMode).toHaveBeenCalledWith(
      'conv-1',
      'user-1',
      ConversationMuteMode.MentionsOnly,
    );
    expect(result).toEqual({
      ok: true,
      muteMode: ConversationMuteMode.MentionsOnly,
    });
  });
});
