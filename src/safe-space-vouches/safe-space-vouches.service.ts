import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  Listing,
  ListingStatus,
  SafeSpaceStatus,
} from '../listings/entities/listing.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  SafeSpaceNomination,
  SAFE_SPACE_NOMINATION_OPEN_STATUSES,
} from '../safe-space-nominations/entities/safe-space-nomination.entity';
import {
  SafeSpaceMemberVouch,
  type SafeSpaceVouchRelationship,
} from './entities/safe-space-vouch.entity';

export interface CreateSafeSpaceVouchInput {
  note?: string;
  relationship?: SafeSpaceVouchRelationship | null;
  anonymous?: boolean;
}

/**
 * Member-facing writes for safe-space vouches — the write half that mirrors the
 * `VouchService` member-vouch module. Resolves the space by its listing SLUG
 * (the same identifier the public read path `getSafeSpaceBySlug` uses), then
 * inserts/withdraws a normalized `safe_space_member_vouches` row. The read path
 * (`DirectoryService`) merges these rows into the safe-space detail DTO.
 */
@Injectable()
export class SafeSpaceVouchesService {
  constructor(
    @InjectRepository(SafeSpaceMemberVouch)
    private readonly memberVouches: Repository<SafeSpaceMemberVouch>,
    @InjectRepository(Listing)
    private readonly listings: Repository<Listing>,
    private readonly notifications: NotificationsService,
    @InjectRepository(SafeSpaceNomination)
    private readonly nominations: Repository<SafeSpaceNomination>,
  ) {}

  /**
   * Record the current member's vouch for a verified safe space. One row per
   * (space, voucher) ever: a withdrawn row re-activates in place (keeps
   * id/createdAt) rather than 409-ing; an ACTIVE row is a genuine duplicate.
   * Returns the space's live vouch count so the client can reflect it.
   */
  async createVouch(
    voucherId: string,
    slug: string,
    input?: CreateSafeSpaceVouchInput,
  ): Promise<{ vouchCount: number }> {
    const listing = await this.resolveVouchableSpace(slug);

    // A space's own owner cannot vouch for it: a vouch is a community member's
    // independent endorsement, and letting the owner +1 their own public
    // `vouchCount` inflates that signal. Mirrors the self-report guard in
    // `ReportsService` (you cannot report your own content).
    if (listing.ownerId && listing.ownerId === voucherId) {
      throw new BadRequestException('You cannot vouch for your own space');
    }

    // Empty/whitespace-only notes are stored as null, not "" — mirrors VouchService.
    const trimmedNote = input?.note?.trim();
    const cleanNote = trimmedNote ? trimmedNote : null;
    const relationship = input?.relationship ?? null;
    const anonymous = input?.anonymous ?? false;

    const existing = await this.memberVouches.findOne({
      where: { listingId: listing.id, voucherId },
    });
    if (existing && existing.withdrawnAt === null) {
      throw new ConflictException('You have already vouched for this space');
    }

    if (existing) {
      // Withdrawn → reactivate in place.
      await this.memberVouches.update(
        { id: existing.id },
        { withdrawnAt: null, note: cleanNote, relationship, anonymous },
      );
    } else {
      try {
        await this.memberVouches.insert({
          listingId: listing.id,
          voucherId,
          note: cleanNote,
          relationship,
          anonymous,
        });
      } catch (error) {
        // The pre-check can be lost to a concurrent vouch; the UNIQUE
        // constraint is the real backstop. Map it to a 409, not a 500.
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'You have already vouched for this space',
          );
        }
        throw error;
      }
    }

    // Tell the space's listing OWNER their space was vouched for (skip a member
    // vouching for their own space, and listings with no real owner). Best-effort
    // and deep-linked to the space's detail page via `slug` by the push listener.
    // The voucher is the actor, so an owner who blocked/muted them is filtered by
    // `NotificationsService.create`; the voucher's id rides in the payload only
    // for a NAMED vouch, so an anonymous vouch is never attributed while the
    // block/mute gate above still fires (the `actorId` argument is always the
    // voucher). Emits `NOTIFICATION_CREATED`, which the push listener turns into a
    // Vouches-gated phone push. This is the greenfield fix — before it, a
    // safe-space vouch notified no one.
    if (listing.ownerId && listing.ownerId !== voucherId) {
      try {
        await this.notifications.create(
          listing.ownerId,
          NotificationType.SafeSpaceVouch,
          {
            spaceId: listing.id,
            spaceName: listing.name,
            spaceSlug: listing.slug,
            ...(anonymous ? {} : { voucherId }),
          },
          voucherId,
        );
      } catch {
        // Intentionally ignored — the vouch already committed; the owner
        // notification is a best-effort side effect that must never fail it.
      }
    }

    const vouchCount = await this.memberVouches.count({
      where: { listingId: listing.id, withdrawnAt: IsNull() },
    });
    return { vouchCount };
  }

  /** Withdraw the current member's active vouch for a space (soft-delete). */
  async withdrawVouch(voucherId: string, slug: string): Promise<{ ok: true }> {
    const listing = await this.resolveVouchableSpace(slug);
    const active = await this.memberVouches.findOne({
      where: { listingId: listing.id, voucherId, withdrawnAt: IsNull() },
    });
    if (!active) {
      throw new NotFoundException('No vouch to withdraw');
    }
    await this.memberVouches.update(
      { id: active.id },
      { withdrawnAt: new Date() },
    );
    return { ok: true };
  }

  /**
   * The space must exist, be live and be publicly shown, and must be somewhere
   * a vouch means something.
   *
   * TWO ways it can be. The first is the original one: the space already
   * carries a verified badge, and a vouch is a member adding their name to it.
   * The second is new and is the point of this change: the space is UNDER
   * REVIEW — a nomination has been acknowledged or assigned for visits and
   * points at this listing — and a vouch is one of the three independent member
   * visits the published copy promises before a badge is granted.
   *
   * Refusing the second case is what made the promise unkeepable. Vouching used
   * to require an already-verified space, so the visits that were supposed to
   * EARN a badge could only be recorded after it had been granted, and the
   * three-visit step existed in the copy alone.
   *
   * A listing its owner has paused is unreachable on the public page the vouch
   * button lives on, so it resolves as not-found here for the same reason
   * `DirectoryService.getSafeSpaceBySlug` 404s it.
   */
  private async resolveVouchableSpace(slug: string): Promise<Listing> {
    const listing = await this.listings.findOne({
      where: { slug, status: ListingStatus.Live, isHiddenByOwner: false },
    });
    if (!listing) {
      throw new NotFoundException('Safe space not found');
    }
    if (listing.safeSpaceStatus === SafeSpaceStatus.Verified) {
      return listing;
    }
    const openNominationCount = await this.nominations.count({
      where: {
        listingId: listing.id,
        status: In(SAFE_SPACE_NOMINATION_OPEN_STATUSES),
      },
    });
    if (openNominationCount === 0) {
      throw new BadRequestException(
        'This space is not a verified safe space and is not under review',
      );
    }
    return listing;
  }
}
