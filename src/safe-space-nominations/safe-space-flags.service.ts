import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Listing, SafeSpaceStatus } from '../listings/entities/listing.entity';
import {
  AdminFlagsQuery,
  CreateSafeSpaceFlagDto,
  ResolveSafeSpaceFlagDto,
} from './dto/safe-space-flag.dto';
import { SafeSpaceFlag } from './entities/safe-space-flag.entity';
import {
  SafeSpaceAuditAction,
  SafeSpaceAuditService,
} from './safe-space-audit.service';
import {
  AdminSafeSpaceFlagResponse,
  MemberSafeSpaceFlagResponse,
  toAdminSafeSpaceFlagResponse,
  toMemberSafeSpaceFlagResponse,
} from './safe-space-badge-response';
import { SafeSpaceBadgeService } from './safe-space-badge.service';
import {
  SafeSpaceNotificationAction,
  SafeSpaceNotifierService,
} from './safe-space-notifier.service';
import { SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD } from './safe-space-policy';

/**
 * The member-facing "this space is not what the badge says" path, and the
 * moderator queue that answers it.
 *
 * Before this, `listings.safe_space_removal.flags` was a number nothing could
 * ever write: the published promise that three flags trigger a review and a
 * temporary suspension had no endpoint behind it at all, so a member who had a
 * bad experience in a badged space had no way to say so.
 *
 * THE FLAGGER IS NEVER NAMED outside the moderator queue. Every notification in
 * this file goes through `SafeSpaceNotifierService`, which attaches no actor,
 * and the owner-facing copy never quotes a flag's reason or detail.
 */
@Injectable()
export class SafeSpaceFlagsService {
  constructor(
    @InjectRepository(SafeSpaceFlag)
    private readonly flags: Repository<SafeSpaceFlag>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    private readonly badges: SafeSpaceBadgeService,
    private readonly audits: SafeSpaceAuditService,
    private readonly notifier: SafeSpaceNotifierService,
  ) {}

  /**
   * Raise a flag against a badged safe space.
   *
   * IDEMPOTENT. A member with a flag already open on this space gets that same
   * flag back with `wasAlreadyFlagged: true` rather than a second row or a 409,
   * so a double tap cannot inflate the count that suspends a badge. The partial
   * UNIQUE index over `(listing_id, flagger_id)` where the flag is still open
   * is the backstop for the concurrent case.
   *
   * Crossing {@link SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD} distinct open flags
   * suspends the badge immediately, exactly as the copy promises. The
   * suspension is what raises the moderation item; nothing here decides
   * anything about the space itself.
   */
  async flag(
    flaggerId: string,
    slug: string,
    dto: CreateSafeSpaceFlagDto,
  ): Promise<MemberSafeSpaceFlagResponse> {
    const listing = await this.badges.resolvePublicSpaceBySlug(slug);
    if (listing.safeSpaceStatus !== SafeSpaceStatus.Verified) {
      throw new BadRequestException(
        'This space does not carry a safe-space badge',
      );
    }
    if (listing.ownerId && listing.ownerId === flaggerId) {
      throw new BadRequestException('You cannot flag your own space');
    }

    const alreadyOpen = await this.flags.findOne({
      where: {
        listingId: listing.id,
        flaggerId,
        withdrawnAt: IsNull(),
        resolvedAt: IsNull(),
      },
    });
    if (alreadyOpen) {
      return toMemberSafeSpaceFlagResponse(alreadyOpen, listing.slug, true);
    }

    const detail = dto.detail?.trim() || null;
    let flag: SafeSpaceFlag;
    try {
      flag = await this.flags.save(
        this.flags.create({
          listingId: listing.id,
          flaggerId,
          reasonCode: dto.reasonCode,
          detail,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.flags.findOne({
          where: {
            listingId: listing.id,
            flaggerId,
            withdrawnAt: IsNull(),
            resolvedAt: IsNull(),
          },
        });
        if (winner) {
          return toMemberSafeSpaceFlagResponse(winner, listing.slug, true);
        }
      }
      throw error;
    }

    await this.audits.record({
      subjectType: 'flag',
      subjectId: flag.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.FlagRaised,
      actorId: flaggerId,
      reason: dto.reasonCode,
      metadata: { reasonCode: dto.reasonCode },
    });

    const openFlags = await this.badges.openFlagsForListing(listing.id);
    if (openFlags.length >= SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD) {
      await this.badges.suspendForFlagThreshold(
        listing,
        openFlags.length,
        openFlags.map((openFlag) => openFlag.flaggerId),
      );
    }

    return toMemberSafeSpaceFlagResponse(flag, listing.slug, false);
  }

  /**
   * Withdraw your own open flag. Never lifts a suspension: the review was
   * opened by three people and only a moderator closes it. Withdrawing does
   * drop the flag out of the open count, so the threshold is not permanently
   * armed by a flag its author has taken back.
   */
  async withdraw(flaggerId: string, slug: string): Promise<{ ok: true }> {
    const listing = await this.badges.resolvePublicSpaceBySlug(slug);
    const open = await this.flags.findOne({
      where: {
        listingId: listing.id,
        flaggerId,
        withdrawnAt: IsNull(),
        resolvedAt: IsNull(),
      },
    });
    if (!open) throw new NotFoundException('No flag to withdraw');
    await this.flags.update({ id: open.id }, { withdrawnAt: new Date() });
    await this.audits.record({
      subjectType: 'flag',
      subjectId: open.id,
      listingId: listing.id,
      action: SafeSpaceAuditAction.FlagWithdrawn,
      actorId: flaggerId,
    });
    return { ok: true };
  }

  /** The flagger's own view of their own open flag, or null. */
  async myFlag(
    flaggerId: string,
    slug: string,
  ): Promise<MemberSafeSpaceFlagResponse | null> {
    const listing = await this.badges.resolvePublicSpaceBySlug(slug);
    const open = await this.flags.findOne({
      where: {
        listingId: listing.id,
        flaggerId,
        withdrawnAt: IsNull(),
        resolvedAt: IsNull(),
      },
    });
    return open ? toMemberSafeSpaceFlagResponse(open, listing.slug) : null;
  }

  // --- Moderator queue ----------------------------------------------------

  async listForAdmin(
    query: AdminFlagsQuery,
  ): Promise<{ items: AdminSafeSpaceFlagResponse[]; total: number }> {
    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;
    const builder = this.flags
      .createQueryBuilder('flag')
      .orderBy('flag.createdAt', 'DESC')
      .offset(offset)
      .limit(limit);

    const state = query.state ?? 'open';
    if (state === 'open') {
      builder
        .andWhere('flag.withdrawnAt IS NULL')
        .andWhere('flag.resolvedAt IS NULL');
    } else if (state === 'resolved') {
      builder.andWhere('flag.resolvedAt IS NOT NULL');
    }
    if (query.reasonCode) {
      builder.andWhere('flag.reasonCode = :reasonCode', {
        reasonCode: query.reasonCode,
      });
    }
    if (query.listingRef) {
      const listing = await this.badges.resolveByRef(query.listingRef);
      builder.andWhere('flag.listingId = :listingId', {
        listingId: listing.id,
      });
    }
    if (query.suspendedOnly) {
      // Correlated existence check rather than a join, so pagination stays on
      // the flag rows and no listing can multiply them.
      builder.andWhere(
        `EXISTS (SELECT 1 FROM "safe_space_badge_suspensions" suspension
                  WHERE suspension.listing_id = flag.listing_id
                    AND suspension.lifted_at IS NULL)`,
      );
    }

    const [rows, total] = await builder.getManyAndCount();
    const listings = await this.listingSummaries(
      rows.map((flag) => flag.listingId),
    );
    return {
      items: rows.map((flag) =>
        toAdminSafeSpaceFlagResponse(flag, listings.get(flag.listingId)),
      ),
      total,
    };
  }

  /** Close one flag. Tells its author what happened, because a member who
   * raises something and is never answered does not raise the next one. */
  async resolveFlag(
    flagId: string,
    actorId: string,
    dto: ResolveSafeSpaceFlagDto,
  ): Promise<AdminSafeSpaceFlagResponse> {
    const flag = await this.flags.findOne({ where: { id: flagId } });
    if (!flag) throw new NotFoundException('Flag not found');
    if (flag.resolvedAt) {
      throw new BadRequestException('This flag is already resolved');
    }
    const note = dto.note?.trim() || null;
    await this.flags.update(
      { id: flag.id },
      {
        resolvedAt: new Date(),
        resolvedBy: actorId,
        resolution: dto.resolution,
        resolutionNote: note,
      },
    );
    await this.audits.record({
      subjectType: 'flag',
      subjectId: flag.id,
      listingId: flag.listingId,
      action: SafeSpaceAuditAction.FlagResolved,
      actorId,
      reason: note,
      metadata: { resolution: dto.resolution },
    });
    const listing = await this.listings.findOne({
      where: { id: flag.listingId },
    });
    await this.notifier.tell(
      [flag.flaggerId],
      SafeSpaceNotificationAction.FlagResolved,
      listing
        ? `The review team finished looking at what you raised about ${listing.name}.`
        : 'The review team finished looking at what you raised.',
      listing?.slug ?? null,
    );
    const updated = await this.flags.findOne({ where: { id: flag.id } });
    return toAdminSafeSpaceFlagResponse(
      updated ?? flag,
      listing ? { slug: listing.slug, name: listing.name } : null,
    );
  }

  private async listingSummaries(
    listingIds: string[],
  ): Promise<Map<string, { slug: string; name: string }>> {
    const summaries = new Map<string, { slug: string; name: string }>();
    const unique = [...new Set(listingIds)];
    if (!unique.length) return summaries;
    const rows = await this.listings.find({
      where: { id: In(unique) },
      select: { id: true, slug: true, name: true },
    });
    for (const listing of rows) {
      summaries.set(listing.id, { slug: listing.slug, name: listing.name });
    }
    return summaries;
  }
}
