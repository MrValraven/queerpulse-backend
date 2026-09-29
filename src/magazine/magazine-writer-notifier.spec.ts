import { Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  notifyPieceWriter,
  NotifyPieceWriterParams,
} from './magazine-writer-notifier';

type NotificationsMock = { create: jest.Mock };
type LoggerMock = { warn: jest.Mock };

describe('notifyPieceWriter (PRD-121)', () => {
  let notifications: NotificationsMock;
  let logger: LoggerMock;

  function buildParams(
    overrides: Partial<NotifyPieceWriterParams> = {},
  ): NotifyPieceWriterParams {
    return {
      notifications: notifications as unknown as NotificationsService,
      logger: logger as unknown as Logger,
      piece: { id: 'piece-1', title: 'Pride at forty', writerId: 'writer-1' },
      actorId: 'editor-1',
      type: NotificationType.MagazinePieceCommissioned,
      ...overrides,
    };
  }

  beforeEach(() => {
    notifications = { create: jest.fn().mockResolvedValue(null) };
    logger = { warn: jest.fn() };
  });

  it('notifies the writer with the actor in the payload and as the gate', async () => {
    await notifyPieceWriter(
      buildParams({ extraPayload: { stage: 'editing' } }),
    );

    expect(notifications.create).toHaveBeenCalledWith(
      'writer-1',
      NotificationType.MagazinePieceCommissioned,
      {
        source: 'magazine',
        pieceId: 'piece-1',
        title: 'Pride at forty',
        actorId: 'editor-1',
        stage: 'editing',
      },
      'editor-1',
    );
  });

  it('does nothing for a piece with no writer', async () => {
    await notifyPieceWriter(
      buildParams({
        piece: { id: 'piece-1', title: 'Pride at forty', writerId: null },
      }),
    );

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('does nothing when the writer is the acting editor', async () => {
    await notifyPieceWriter(buildParams({ actorId: 'writer-1' }));

    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('sends a system notification with no actorId key and no gate argument', async () => {
    await notifyPieceWriter(
      buildParams({
        actorId: null,
        type: NotificationType.MagazinePiecePublished,
      }),
    );

    expect(notifications.create).toHaveBeenCalledTimes(1);
    const callArguments = notifications.create.mock.calls[0] as unknown[];
    expect(callArguments).toHaveLength(4);
    expect(callArguments[0]).toBe('writer-1');
    expect(callArguments[1]).toBe(NotificationType.MagazinePiecePublished);
    expect(callArguments[2]).toEqual({
      source: 'magazine',
      pieceId: 'piece-1',
      title: 'Pride at forty',
    });
    expect(callArguments[2]).not.toHaveProperty('actorId');
    expect(callArguments[3]).toBeUndefined();
  });

  it('swallows a failed create and logs a warning', async () => {
    notifications.create.mockRejectedValue(new Error('database down'));

    await expect(notifyPieceWriter(buildParams())).resolves.toBeUndefined();

    expect(logger.warn).toHaveBeenCalledWith(
      'Failed to notify writer writer-1 of piece piece-1 (magazine_piece_commissioned): database down',
    );
  });
});
