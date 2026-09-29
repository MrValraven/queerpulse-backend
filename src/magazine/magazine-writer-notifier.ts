import { Logger } from '@nestjs/common';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { MagazinePiece } from './entities/magazine-piece.entity';

export interface NotifyPieceWriterParams {
  notifications: NotificationsService;
  logger: Logger;
  piece: Pick<MagazinePiece, 'id' | 'title' | 'writerId'>;
  /** The acting editor, or `null` when the platform itself acted. */
  actorId: string | null;
  type: NotificationType;
  extraPayload?: Record<string, unknown>;
}

/**
 * PRD-121: the single emit point for every writer-facing piece
 * notification (commissioned, stage changed, published).
 *
 * Before this the desk was silent: commissioning, assigning, stage changes
 * and publishing all wrote nothing, and the only writer-facing piece
 * notification in the whole module was `MagazinePieceMessage`. A writer
 * found out they had been given a piece by opening `/magazine/writer` on a
 * hunch.
 *
 * Three rules, all enforced here so no caller can forget one:
 *   - No writer, no notification.
 *   - Never notify someone about their OWN action. The desk's "I write this
 *     one" makes an editor their own writer (`writerId === editorId`), and a
 *     bell that tells you what you just did is noise.
 *   - The acting editor rides along as the `actorId` argument, exactly like
 *     `MagazinePieceMessage`, so block/mute filtering applies. A `null` actor
 *     is the platform speaking: no `actorId` key and no block/mute gate.
 *
 * Emission NEVER fails the mutation it hangs off. A commission that rolled
 * back because a bell could not ring would be a far worse bug than a missing
 * bell, so this swallows and logs like
 * `MagazineIssueAnnouncerService.announceIssueIfDue`.
 */
export async function notifyPieceWriter(
  params: NotifyPieceWriterParams,
): Promise<void> {
  const { notifications, logger, piece, actorId, type } = params;
  const writerId = piece.writerId;
  if (writerId === null) {
    return;
  }
  if (actorId !== null && writerId === actorId) {
    return;
  }

  try {
    await notifications.create(
      writerId,
      type,
      {
        source: 'magazine',
        pieceId: piece.id,
        title: piece.title,
        // `actorId` rides in the payload as well as in the argument below:
        // the argument is the block/mute gate, and the payload key is what
        // `ACTOR_PAYLOAD_KEY` resolves into the bell row's `actor` (the
        // response mapper strips the raw id on the way out). Without it the
        // row would read as the platform speaking, which is exactly what a
        // `null` actor means, so that case leaves the key out.
        ...(actorId !== null ? { actorId } : {}),
        ...params.extraPayload,
      },
      actorId ?? undefined,
    );
  } catch (error) {
    logger.warn(
      `Failed to notify writer ${writerId} of piece ${piece.id} (${type}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
