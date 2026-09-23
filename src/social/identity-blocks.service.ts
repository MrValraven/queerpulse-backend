import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { IDENTITY_BLOCKED, IdentityBlockedEvent } from './social.events';
import { IdentityBlockDTO, toIdentityBlockDTO } from './social-response';

/**
 * Task 14: a member blocking a whole business, persona or company. The rule
 * the block puts in force, that every thread between the member and that
 * identity's mailbox disappears for both sides, lives in
 * `messaging/mailbox-seats.ts` and reads `identity_blocks` at request time,
 * so this service only writes and lists the rows. Always on, like the
 * person blocks beside it.
 *
 * Talks to `IdentitiesService` for the identity's kind, its staff and its
 * display fields. `IdentitiesModule` imports nothing from `social`, so
 * `SocialModule` imports it directly with no `forwardRef`.
 */
@Injectable()
export class IdentityBlocksService {
  constructor(
    @InjectRepository(IdentityBlock)
    private readonly identityBlocks: Repository<IdentityBlock>,
    private readonly identities: IdentitiesService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** The caller's identity blocks, newest first, paginated like
   *  `GET /blocks`, with every page's display fields read in one batch. */
  async listIdentityBlocks(
    userId: string,
    page?: number,
  ): Promise<Paginated<IdentityBlockDTO>> {
    const queryBuilder = this.identityBlocks
      .createQueryBuilder('identity_block')
      .where('identity_block.blockerUserId = :userId', { userId })
      .orderBy('identity_block.createdAt', 'DESC')
      .addOrderBy('identity_block.id', 'DESC');
    return paginate(queryBuilder, normalizePage(page), async (rows) => {
      const identityIds = rows.map((row) => row.identityId);
      const [blockedIdentities, descriptionById] = await Promise.all([
        this.identities.getByIds(identityIds),
        this.identities.describeIdentities(identityIds),
      ]);
      const kindById = new Map(
        blockedIdentities.map((identity) => [identity.id, identity.kind]),
      );
      return rows.map((row) =>
        toIdentityBlockDTO(
          row,
          kindById.get(row.identityId),
          descriptionById.get(row.identityId),
        ),
      );
    });
  }

  /**
   * Idempotent: blocking an identity already blocked returns the existing
   * row. Refuses an unknown identity (404), a `profile` identity, which is a
   * person that a person block covers (400), and an identity the caller
   * acts for as owner, co-manager, persona member or team member (400).
   * After the write returns, and only when it placed a new row,
   * `IDENTITY_BLOCKED` lets the chat gateway move both sides out of the live
   * rooms of their threads.
   */
  async blockIdentity(
    userId: string,
    identityId: string,
  ): Promise<IdentityBlockDTO> {
    const identity = await this.identities.getById(identityId);
    if (!identity) {
      throw new NotFoundException('Identity not found');
    }
    if (identity.kind === IdentityKind.Profile) {
      throw new BadRequestException({
        code: 'IDENTITY_BLOCK_PERSON',
        message: 'Block a person from their profile',
      });
    }
    if (await this.identities.isAllowedToActAs(userId, identityId)) {
      throw new BadRequestException({
        code: 'IDENTITY_BLOCK_OWN',
        message: 'You cannot block a mailbox you answer for',
      });
    }
    const inserted = await this.identityBlocks
      .createQueryBuilder()
      .insert()
      .into(IdentityBlock)
      .values({ blockerUserId: userId, identityId })
      .orIgnore()
      .returning(['id'])
      .execute();
    // On conflict the row is skipped and no `RETURNING` row comes back, so
    // only the call that placed the block tells the gateway. A repeat block
    // finds every socket already out of the rooms.
    const isNewBlock =
      ((inserted.raw as unknown[] | undefined) ?? []).length > 0;
    const row = await this.identityBlocks.findOneOrFail({
      where: { blockerUserId: userId, identityId },
    });
    if (isNewBlock) {
      this.emitBestEffort(IDENTITY_BLOCKED, {
        blockerUserId: userId,
        identityId,
      } satisfies IdentityBlockedEvent);
    }
    const descriptionById = await this.identities.describeIdentities([
      identityId,
    ]);
    return toIdentityBlockDTO(
      row,
      identity.kind,
      descriptionById.get(identityId),
    );
  }

  /** Idempotent: lifting a block that does not exist succeeds as well. The
   *  threads come back on their next read, since every check reads the
   *  table at request time. */
  async unblockIdentity(userId: string, identityId: string): Promise<void> {
    await this.identityBlocks.delete({ blockerUserId: userId, identityId });
  }

  /** A listener's failure never fails a block that has been written.
   *  Mirrors `SocialService.emitBestEffort`. */
  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch {
      // best-effort: the live eviction never fails a written block.
    }
  }
}
