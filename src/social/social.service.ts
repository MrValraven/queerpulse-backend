import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
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

  /** Idempotent: re-blocking an already-blocked member returns the existing row. */
  async blockMember(
    actorId: string,
    slug: string,
    dto?: BlockOptionsDto,
  ): Promise<BlockDTO> {
    const blockedId = await this.resolveMutationTarget(actorId, slug);

    await this.blocks
      .createQueryBuilder()
      .insert()
      .into(Block)
      .values({ blockerId: actorId, blockedId, reason: dto?.reason ?? null })
      .orIgnore()
      .execute();

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

  async unblockMember(actorId: string, slug: string): Promise<void> {
    const blockedId = await this.resolveMutationTarget(actorId, slug);
    const result = await this.blocks.delete({
      blockerId: actorId,
      blockedId,
    });
    if (!result.affected) {
      throw new NotFoundException('Block not found');
    }
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
