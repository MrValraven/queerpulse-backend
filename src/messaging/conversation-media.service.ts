import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { ConversationMediaKind } from './dto/list-conversation-media.query';
import { Message, MessageKind } from './entities/message.entity';
import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
  EXACT_CREATED_AT_SELECT,
} from './message-history-cursor';
import { MessageHistoryPage } from './message-response';
import {
  MESSAGE_SUBJECT_TYPE,
  notModeratedMessagePredicate,
} from './message-visibility-predicates';
import {
  DEFAULT_LIMIT,
  MAX_CONVERSATION_MEDIA_LIMIT,
} from './messaging.constants';
import { MessagingCoreService } from './messaging-core.service';

/**
 * Postgres case-insensitive regex (`~*`) a `links` row's body must match: an
 * `http://` or `https://` address, or a bare `www.` host. Aligned with the
 * frontend's link detection so the Links tab lists what the thread renders as
 * a link. Bound as a parameter, and only ever tested against `kind = 'user'`
 * bodies, so a caption on an image or document does not count.
 */
export const LINK_BODY_PATTERN = '(https?://|www\\.)';

/** Options for `listConversationMedia`; mirrors `ListConversationMediaQuery`. */
export interface ListConversationMediaOptions {
  kind: ConversationMediaKind;
  cursor?: string;
  limit?: number;
}

/**
 * PRD-373: the per-conversation media, links and documents gallery.
 *
 * One keyset-paginated listing, newest first, returned in the SAME
 * `MessageHistoryPage` envelope and `MessageResponse` mapping thread history
 * uses, so the client can render and page it with the code it already has.
 *
 * Visibility mirrors `MessagesService.getMessages` on every axis a gallery can
 * observe:
 *  - participation through `MessagingCoreService.requireParticipant` (403 for a
 *    non-participant, identical to history);
 *  - the caller's `clearedAt` floor and `leftAt` ceiling;
 *  - PRD-227 per-viewer hides (`message_hides`).
 *
 * Two rules are stricter than history, on purpose. History keeps a
 * soft-deleted or taken-down message in its slot as a tombstone so the thread
 * has no gap; a gallery has no timeline to keep intact, and a tombstone tile
 * with no attachment is meaningless. So soft-deleted rows are dropped (no
 * `.withDeleted()`) and a moderator takedown, hidden or removed, drops the row
 * for every viewer, exactly as `searchMessages` and `listStarredMessages` do.
 * Filtering both in SQL keeps a capped page from being under-filled.
 *
 * Blocks are enforced on the write paths, matching history: a block stops new
 * writes to a DM, and both sides keep browsing the history they already hold.
 */
@Injectable()
export class ConversationMediaService {
  constructor(
    @InjectRepository(Message)
    private readonly messages: Repository<Message>,
    private readonly core: MessagingCoreService,
  ) {}

  async listConversationMedia(
    conversationId: string,
    userId: string,
    options: ListConversationMediaOptions,
  ): Promise<MessageHistoryPage> {
    const participant = await this.core.requireParticipant(
      conversationId,
      userId,
    );
    const limit = ConversationMediaService.clampLimit(options.limit);
    const queryBuilder = this.messages
      .createQueryBuilder('m')
      // Explicit columns: exactly what `toMessageResponses` reads
      // (`MessageLike`), nothing else off the row.
      .select([
        'm.id',
        'm.conversationId',
        'm.senderId',
        'm.body',
        'm.replyToId',
        'm.createdAt',
        'm.editedAt',
        'm.deletedAt',
        'm.clientMessageId',
        'm.forwarded',
        'm.kind',
        'm.systemEvent',
        'm.attachment',
      ])
      .where('m.conversation_id = :id', { id: conversationId });
    ConversationMediaService.applyKindFilter(queryBuilder, options.kind);
    if (participant.clearedAt) {
      // Same floor as `getMessages`: at-or-before the clear point does not
      // exist for this viewer.
      queryBuilder.andWhere('m.created_at > :clearedAt', {
        clearedAt: participant.clearedAt.toISOString(),
      });
    }
    if (participant.leftAt) {
      // Same ceiling as `getMessages`: a member who left or was removed from a
      // group never browses anything posted after their departure.
      queryBuilder.andWhere('m.created_at <= :leftAt', {
        leftAt: participant.leftAt.toISOString(),
      });
    }
    // PRD-227 "delete for me", identical to the history predicate.
    queryBuilder.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "message_hides" "mh"
        WHERE "mh"."message_id" = m.id AND "mh"."user_id" = :hidingUserId
      )`,
      { hidingUserId: userId },
    );
    // Moderator takedowns (hidden OR removed, keyed by the message uuid),
    // through the shared visibility predicate every message listing composes.
    // Its inner alias is "cm"; this query uses only "m" and "mh".
    queryBuilder.andWhere(notModeratedMessagePredicate('m'), {
      messageSubjectType: MESSAGE_SUBJECT_TYPE,
    });
    // The history cursor codec validates both halves before they reach the
    // `::timestamptz` / `::uuid` casts; anything malformed is the first page.
    const decodedCursor = options.cursor
      ? decodeMessageHistoryCursor(options.cursor)
      : null;
    if (decodedCursor) {
      queryBuilder.andWhere(
        '(m.created_at, m.id) < (:before::timestamptz, :beforeId::uuid)',
        { before: decodedCursor.before, beforeId: decodedCursor.beforeId },
      );
    }
    // No `.withDeleted()`: the @DeleteDateColumn default filter drops
    // soft-deleted rows (see the class comment). `limit + 1` rows decide
    // `hasMore` without a count query, and the exact created_at text rides
    // along so the next cursor is lossless, as in `getMessages`.
    const { entities, raw } = await queryBuilder
      .addSelect(EXACT_CREATED_AT_SELECT, 'cursor_created_at')
      .orderBy('m.created_at', 'DESC')
      .addOrderBy('m.id', 'DESC')
      .take(limit + 1)
      .getRawAndEntities<{ m_id: string; cursor_created_at: string }>();
    const hasMore = entities.length > limit;
    const pageRows = hasMore ? entities.slice(0, limit) : entities;
    const oldestRow = pageRows[pageRows.length - 1];
    let nextCursor: string | null = null;
    if (hasMore && oldestRow) {
      // No join, so every entity has its own raw row. The millisecond fallback
      // only guards a driver surprise, exactly as in `getMessages`.
      const oldestRawRow = raw.find((rawRow) => rawRow.m_id === oldestRow.id);
      const exactCreatedAt =
        oldestRawRow?.cursor_created_at ?? oldestRow.createdAt.toISOString();
      nextCursor = encodeMessageHistoryCursor(exactCreatedAt, oldestRow.id);
    }
    return {
      data: await this.core.toMessageResponses(
        pageRows,
        userId,
        Boolean(participant.leftAt),
      ),
      pageInfo: { nextCursor, hasMore },
    };
  }

  /** 1..50, defaulting to the thread history page size. */
  private static clampLimit(limit: number | undefined): number {
    return Math.min(
      Math.max(limit ?? DEFAULT_LIMIT, 1),
      MAX_CONVERSATION_MEDIA_LIMIT,
    );
  }

  private static applyKindFilter(
    queryBuilder: SelectQueryBuilder<Message>,
    kind: ConversationMediaKind,
  ): void {
    switch (kind) {
      case ConversationMediaKind.Media:
        queryBuilder.andWhere('m.kind IN (:...mediaKinds)', {
          mediaKinds: [MessageKind.Image, MessageKind.Gif],
        });
        return;
      case ConversationMediaKind.Documents:
        queryBuilder.andWhere('m.kind = :documentKind', {
          documentKind: MessageKind.Document,
        });
        return;
      case ConversationMediaKind.Links:
        // Ordinary text bubbles only; the conversation filter above bounds the
        // regex scan to this one thread.
        queryBuilder
          .andWhere('m.kind = :textKind', { textKind: MessageKind.User })
          .andWhere('m.body ~* :linkPattern', {
            linkPattern: LINK_BODY_PATTERN,
          });
        return;
    }
  }
}
