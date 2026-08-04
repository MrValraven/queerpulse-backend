import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Not, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { ReportsService } from '../reports/reports.service';
import { ReportSubjectType } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { BlockOptionsDto } from './dto/block-options.dto';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';
import {
  BlockDTO,
  BlockStatus,
  MuteDTO,
  toBlockDTO,
  toMuteDTO,
} from './social-response';

/**
 * Blocks & mutes CRUD (spec §3 Tier 1 "social"). Always-on safety primitives
 * — no `@Feature` flag. Mirrors `ConnectionsService`'s slug-resolution +
 * idempotent-insert idioms (`connections.service.ts`,
 * `community-posts.service.ts#addReaction`).
 */
@Injectable()
export class SocialService {
  private readonly memberLookup: MemberLookup;

  constructor(
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    @InjectRepository(Mute) private readonly mutes: Repository<Mute>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly reportsService: ReportsService,
    private readonly dataSource: DataSource,
  ) {
    this.memberLookup = new MemberLookup(this.profiles);
  }

  // --- blocks ---

  async listBlocks(
    userId: string,
    page?: number,
  ): Promise<Paginated<BlockDTO>> {
    const qb = this.blocks
      .createQueryBuilder('block')
      .where('block.blockerId = :userId', { userId })
      .orderBy('block.createdAt', 'DESC')
      .addOrderBy('block.id', 'DESC');

    return paginate(qb, normalizePage(page), async (rows) => {
      const members = await this.memberLookup.byUserIds(
        rows.map((r) => r.blockedId),
      );
      return rows.map((r) => toBlockDTO(r, members.get(r.blockedId)));
    });
  }

  /**
   * Idempotent: re-blocking an already-blocked member returns the existing row.
   *
   * Transactional: the block row AND the severing of any existing
   * `connections` edge commit together (P0 fix — `blocks` used to be a
   * standalone primitive with "no bearing on connection state" per the
   * entity's docstring, which meant blocking someone left a prior `Accepted`
   * connection in place; `MessagingService.sendMessage`'s `areConnected` gate,
   * and presence/typing which are also connection-derived, kept treating the
   * pair as connected — a blocked member could still DM the blocker and show
   * up online to them). Reuses the SAME `Blocked` status + `blockedBy` the
   * connections `respond('block')` action already writes, so every
   * connections-side read (`areConnected`, `getAcceptedConnectionUserIds`, …)
   * sees the pair as severed regardless of which of the two block mechanisms
   * placed it. A connection already `Blocked` (by either party) is left
   * untouched — it's already severed, and overwriting `blockedBy` here would
   * let this actor seize a block the OTHER party placed, which is exactly
   * what `ConnectionsService.respond('unblock')`'s "only the blocker can
   * unblock" check guards against.
   */
  async blockMember(
    actorId: string,
    slug: string,
    dto?: BlockOptionsDto,
  ): Promise<BlockDTO> {
    const blockedId = await this.resolveMutationTarget(actorId, slug);
    const { low, high } = this.orderedPair(actorId, blockedId);

    await this.dataSource.transaction(async (manager) => {
      await manager
        .createQueryBuilder()
        .insert()
        .into(Block)
        .values({ blockerId: actorId, blockedId, reason: dto?.reason ?? null })
        .orIgnore()
        .execute();

      await manager.update(
        Connection,
        { userLow: low, userHigh: high, status: Not(ConnectionStatus.Blocked) },
        {
          status: ConnectionStatus.Blocked,
          blockedBy: actorId,
          respondedAt: new Date(),
        },
      );
    });

    const row = await this.blocks.findOneOrFail({
      where: { blockerId: actorId, blockedId },
    });

    // `alsoReport`: file a companion report against the blocked member so
    // moderation sees it too (spec §3 Tier 1 "social" `BlockOptions`). Runs
    // after the block itself is committed (idempotent above); `reason`, if
    // given, doubles as the report's reason so moderators see the same
    // context the blocker gave.
    if (dto?.alsoReport) {
      // `reasonCode` is now a closed, server-owned taxonomy (see
      // `.superpowers/sdd/connect-FINAL-review.md` C2/C3) rather than the
      // free string this used to accept — `other` plus the blocker's free
      // text (if any) as `detail` preserves the same moderator-visible
      // context without requiring the blocker to pick from the taxonomy.
      await this.reportsService.create(actorId, {
        subjectType: ReportSubjectType.Member,
        subjectId: blockedId,
        reasonCode: 'other',
        detail: dto.reason ?? 'Filed alongside a block.',
      });
    }

    const members = await this.memberLookup.byUserIds([blockedId]);
    return toBlockDTO(row, members.get(blockedId));
  }

  /**
   * Transactional inverse of {@link blockMember}: deletes the `blocks` row AND
   * restores the connection edge this actor's block severed (P1-3 — P0 left
   * this as a flagged residual, so `blockMember` severed the connection but
   * `unblockMember` never lifted it, leaving the pair stuck at `Blocked`). The
   * connection flip is conditional on `blockedBy = actorId`, exactly mirroring
   * `ConnectionsService.respond('unblock')`: a `Blocked` row the OTHER party
   * placed is left untouched (only they can lift it), and the pair is returned
   * to `Declined` (not `Accepted` — re-connecting requires a fresh request),
   * matching the connections-side unblock. A pair that never had a connection
   * row (a block placed on a stranger) simply matches nothing here.
   */
  async unblockMember(actorId: string, slug: string): Promise<void> {
    const blockedId = await this.resolveMutationTarget(actorId, slug);
    const { low, high } = this.orderedPair(actorId, blockedId);

    await this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(Block, {
        blockerId: actorId,
        blockedId,
      });
      if (!result.affected) {
        throw new NotFoundException('Block not found');
      }
      await manager.update(
        Connection,
        {
          userLow: low,
          userHigh: high,
          status: ConnectionStatus.Blocked,
          blockedBy: actorId,
        },
        { status: ConnectionStatus.Declined, blockedBy: null },
      );
    });
  }

  /**
   * `{ blocking, blockedBy }` — MUST NOT leak anything beyond these two
   * booleans (spec §3 Tier 1). Allows a self-slug (returns `false`/`false`
   * rather than erroring) since this is a read, not a mutation.
   */
  async getBlockStatus(actorId: string, slug: string): Promise<BlockStatus> {
    const targetId = await this.resolveSlugStrict(slug);
    const [blocking, blockedBy] = await Promise.all([
      this.blocks.exist({
        where: { blockerId: actorId, blockedId: targetId },
      }),
      this.blocks.exist({
        where: { blockerId: targetId, blockedId: actorId },
      }),
    ]);
    return { blocking, blockedBy };
  }

  // --- mutes ---

  async listMutes(userId: string, page?: number): Promise<Paginated<MuteDTO>> {
    const qb = this.mutes
      .createQueryBuilder('mute')
      .where('mute.muterId = :userId', { userId })
      .orderBy('mute.createdAt', 'DESC')
      .addOrderBy('mute.id', 'DESC');

    return paginate(qb, normalizePage(page), async (rows) => {
      const members = await this.memberLookup.byUserIds(
        rows.map((r) => r.mutedId),
      );
      return rows.map((r) => toMuteDTO(r, members.get(r.mutedId)));
    });
  }

  /** Idempotent: re-muting an already-muted member returns the existing row. */
  async muteMember(actorId: string, slug: string): Promise<MuteDTO> {
    const mutedId = await this.resolveMutationTarget(actorId, slug);

    await this.mutes
      .createQueryBuilder()
      .insert()
      .into(Mute)
      .values({ muterId: actorId, mutedId })
      .orIgnore()
      .execute();

    const row = await this.mutes.findOneOrFail({
      where: { muterId: actorId, mutedId },
    });
    const members = await this.memberLookup.byUserIds([mutedId]);
    return toMuteDTO(row, members.get(mutedId));
  }

  async unmuteMember(actorId: string, slug: string): Promise<void> {
    const mutedId = await this.resolveMutationTarget(actorId, slug);
    const result = await this.mutes.delete({ muterId: actorId, mutedId });
    if (!result.affected) {
      throw new NotFoundException('Mute not found');
    }
  }

  // --- internals ---

  /**
   * Canonical unordered pair (least/greatest userId) matching `connections`'
   * own `(userLow, userHigh)` ordering (mirrors `ConnectionsService#pair`,
   * duplicated here rather than imported to avoid a module import cycle —
   * see the module docstring).
   */
  private orderedPair(a: string, b: string): { low: string; high: string } {
    return a < b ? { low: a, high: b } : { low: b, high: a };
  }

  private async resolveSlugStrict(slug: string): Promise<string> {
    const targetId = await this.memberLookup.userIdForSlug(slug);
    if (!targetId) {
      throw new NotFoundException('Member not found');
    }
    return targetId;
  }

  /** Resolves `slug` for a write (block/mute/unblock/unmute): 404 unknown
   * slug, 400 targeting yourself. */
  private async resolveMutationTarget(
    actorId: string,
    slug: string,
  ): Promise<string> {
    const targetId = await this.resolveSlugStrict(slug);
    if (targetId === actorId) {
      throw new BadRequestException('You cannot target yourself');
    }
    return targetId;
  }
}
