import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MEMBER_BLOCKED, MemberBlockedEvent } from '../social/social.events';
import { ForumThread } from './entities/forum-thread.entity';

/**
 * PRD-408. A block between two members drops the co-author credit on every
 * thread one of them wrote and credited the other on, in either direction.
 * Crediting is refused at write time when the pair already has a block
 * (`ForumThreadsService.resolveCoAuthorId`); this covers a block placed after
 * the credit, so neither member's name stays on the other's thread.
 *
 * No bell goes out: telling either member their credit was dropped the moment
 * a block lands would disclose the block.
 *
 * Best-effort, as every `MEMBER_BLOCKED` consumer is (`SocialService` emits it
 * post-commit). The byline's read-time block filter in `ForumThreadsService`
 * is the authoritative gate for viewers; this listener tidies the rows so the
 * credit is gone for everybody.
 */
@Injectable()
export class ForumCoAuthorBlockListener {
  private readonly logger = new Logger(ForumCoAuthorBlockListener.name);

  constructor(
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
  ) {}

  @OnEvent(MEMBER_BLOCKED, { async: true })
  async handleMemberBlocked(event: MemberBlockedEvent): Promise<void> {
    const { blockerId, blockedId } = event;
    if (!blockerId || !blockedId || blockerId === blockedId) return;
    // One UPDATE per direction, each with a single where object. The app sets
    // `invalidWhereValuesBehavior`, under which TypeORM reads an array criteria
    // as an object keyed "0" and "1" and throws, so the pair is split here.
    await this.clearCreditBetween(blockerId, blockedId);
    await this.clearCreditBetween(blockedId, blockerId);
  }

  /** Clears `coAuthorId` on the threads `authorId` wrote crediting
   * `coAuthorId`. Withdrawn threads are included, so a restored thread does
   * not bring the credit back. Each direction catches its own failure, so the
   * second still runs when the first fails. */
  private async clearCreditBetween(
    authorId: string,
    coAuthorId: string,
  ): Promise<void> {
    try {
      await this.threads.update({ authorId, coAuthorId }, { coAuthorId: null });
    } catch (error) {
      this.logger.warn(
        `Dropping forum co-author credits after a block failed: ${String(error)}`,
      );
    }
  }
}
