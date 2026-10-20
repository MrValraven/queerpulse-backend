import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import {
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioAdminClaim,
  StudioAdminClaimCounts,
  toStudioAdminClaim,
} from './studio-claim-response';
import {
  STAFF_QUEUE_CLAIM_STATUSES,
  StudioClaimStaffAction,
  nextStatusForStaffAction,
} from './studio-claim-rule';
import {
  lockClaimWithTrackWithin,
  restoreWithheldTrackWithin,
  withholdTrackWithin,
} from './studio-claim-store';
import { decodeStudioCursor } from './studio-cursor';
import { toKeysetPage } from './studio-keyset-page';
import { toStudioPlaylistMemberCredit } from './studio-playlist-response';
import { StudioPage } from './studio-response';
import {
  STUDIO_CLAIM_LIMITS,
  STUDIO_SAFETY_AUDIT_ACTIONS,
  StudioSafetyAuditAction,
} from './studio-safety.constants';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';

const AUDIT_ACTION_BY_STAFF_ACTION: Readonly<
  Record<StudioClaimStaffAction, StudioSafetyAuditAction>
> = {
  accept: STUDIO_SAFETY_AUDIT_ACTIONS.claimAccepted,
  decline: STUDIO_SAFETY_AUDIT_ACTIONS.claimDeclined,
  uphold: STUDIO_SAFETY_AUDIT_ACTIONS.claimUpheld,
  reject: STUDIO_SAFETY_AUDIT_ACTIONS.claimRejected,
};

/** The audit note: the claim and the track, plus the staff note when there
 *  is one. Never a member. */
export function claimAuditNote(
  claimId: string,
  trackId: string,
  note: string | null,
): string {
  const subject = `claim ${claimId} track ${trackId}`;
  return note ? `${subject}: ${note}` : subject;
}

interface StaffActionOutcome {
  claimantId: string;
  trackId: string;
}

/**
 * Studio safety and moderation (spec 5.2): the staff Claims tab. The queue
 * pages oldest first (`created_at`, then `id`), 20 at a time; with no
 * status it is the work queue (`submitted` and `countered`), which the badge
 * counts. Staff see the claimant (a claim is filed in a member's own name)
 * and the persona the track belongs to; the member who runs it stays
 * hidden.
 *
 * Each action runs in one transaction: the track row, then the claim row
 * (`lockClaimWithTrackWithin`), the transition checked under the lock, the
 * track state change, and an audit row with no target member. Notices go
 * out after commit. `decided_by_id` holds whoever took the latest staff
 * action, accept included.
 */
@Injectable()
export class StudioClaimsAdminService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioCopyrightClaim)
    private readonly claims: Repository<StudioCopyrightClaim>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly catalog: StudioCatalogService,
    private readonly modAudit: ModAuditService,
    private readonly notices: StudioSafetyNoticesService,
  ) {}

  async list(
    status: StudioCopyrightClaimStatus | undefined,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioAdminClaim>> {
    const pageSize = STUDIO_CLAIM_LIMITS.pageSize;
    const queryBuilder = this.claims
      .createQueryBuilder('claim')
      .leftJoinAndSelect('claim.track', 'track')
      .where('claim.status IN (:...claimStatuses)', {
        claimStatuses: status ? [status] : [...STAFF_QUEUE_CLAIM_STATUSES],
      });
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("claim"."created_at", "claim"."id") > (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    const rows = await queryBuilder
      .orderBy('claim.createdAt', 'ASC')
      .addOrderBy('claim.id', 'ASC')
      .limit(pageSize + 1)
      .getMany();
    return toKeysetPage(
      rows,
      pageSize,
      (claim) => ({ publishedAt: claim.createdAt, id: claim.id }),
      (pageRows) => this.toAdminClaims(pageRows),
    );
  }

  /** The badge: one grouped count, no paging. */
  async counts(): Promise<StudioAdminClaimCounts> {
    const rows = await this.claims
      .createQueryBuilder('claim')
      .select('"claim"."status"::text', 'status')
      .addSelect('COUNT(*)::int', 'claim_count')
      .where('claim.status IN (:...queueStatuses)', {
        queueStatuses: [...STAFF_QUEUE_CLAIM_STATUSES],
      })
      .groupBy('"claim"."status"')
      .getRawMany<{ status: string; claim_count: number | string }>();
    const countOf = (claimStatus: string): number =>
      Number(rows.find((row) => row.status === claimStatus)?.claim_count ?? 0);
    return {
      submitted: countOf(StudioCopyrightClaimStatus.Submitted),
      countered: countOf(StudioCopyrightClaimStatus.Countered),
    };
  }

  accept(actorId: string, claimId: string): Promise<StudioAdminClaim> {
    return this.act(actorId, claimId, 'accept', null);
  }

  decline(
    actorId: string,
    claimId: string,
    note: string,
  ): Promise<StudioAdminClaim> {
    return this.act(actorId, claimId, 'decline', note);
  }

  uphold(
    actorId: string,
    claimId: string,
    note: string,
  ): Promise<StudioAdminClaim> {
    return this.act(actorId, claimId, 'uphold', note);
  }

  reject(
    actorId: string,
    claimId: string,
    note: string,
  ): Promise<StudioAdminClaim> {
    return this.act(actorId, claimId, 'reject', note);
  }

  private async act(
    actorId: string,
    claimId: string,
    action: StudioClaimStaffAction,
    note: string | null,
  ): Promise<StudioAdminClaim> {
    const outcome = await this.dataSource.transaction<StaffActionOutcome>(
      async (manager) => {
        const locked = await lockClaimWithTrackWithin(manager, claimId);
        if (!locked) {
          throw new NotFoundException('Claim not found');
        }
        const { claim, track } = locked;
        const nextStatus = nextStatusForStaffAction(action, claim.status);
        const actedAt = new Date();
        claim.status = nextStatus;
        claim.decidedById = actorId;
        if (action === 'accept') {
          claim.acceptedAt = actedAt;
        } else {
          claim.staffNote = note;
          claim.decidedAt = actedAt;
        }
        await manager.save(claim);
        if (action === 'accept') {
          await withholdTrackWithin(manager, track.id);
        }
        if (action === 'reject') {
          // Saved first, so this claim no longer counts toward the hold.
          await restoreWithheldTrackWithin(manager, track.id);
        }
        await this.modAudit.writeAuditLog(
          null,
          actorId,
          AUDIT_ACTION_BY_STAFF_ACTION[action],
          undefined,
          claimAuditNote(claim.id, track.id, note),
          undefined,
          manager,
          null,
        );
        return { claimantId: claim.claimantId, trackId: track.id };
      },
    );
    await this.sendNotice(action, claimId, outcome);
    return this.adminClaim(claimId);
  }

  private sendNotice(
    action: StudioClaimStaffAction,
    claimId: string,
    outcome: StaffActionOutcome,
  ): Promise<void> {
    if (action === 'accept') {
      return this.notices.claimAccepted(claimId, outcome.trackId);
    }
    if (action === 'decline') {
      return this.notices.claimDeclined(
        claimId,
        outcome.claimantId,
        outcome.trackId,
      );
    }
    return this.notices.claimDecided(
      claimId,
      outcome.claimantId,
      outcome.trackId,
      action === 'uphold' ? 'upheld' : 'rejected',
    );
  }

  private async adminClaim(claimId: string): Promise<StudioAdminClaim> {
    const claim = await this.claims.findOne({
      where: { id: claimId },
      relations: { track: true },
    });
    const [adminClaim] = claim ? await this.toAdminClaims([claim]) : [];
    if (!adminClaim) {
      throw new NotFoundException('Claim not found');
    }
    return adminClaim;
  }

  // One release read and one profile read for a whole page. A claim whose
  // track or release went drops out.
  private async toAdminClaims(
    claims: StudioCopyrightClaim[],
  ): Promise<StudioAdminClaim[]> {
    if (!claims.length) {
      return [];
    }
    const [summaries, memberById] = await Promise.all([
      this.catalog.staffSummariesByReleaseId([
        ...new Set(claims.map((claim) => claim.releaseId)),
      ]),
      new MemberLookup(this.profiles).byUserIds([
        ...new Set(claims.map((claim) => claim.claimantId)),
      ]),
    ]);
    return claims.flatMap((claim) => {
      const releaseSummary = summaries.get(claim.releaseId);
      return claim.track && releaseSummary
        ? [
            toStudioAdminClaim(claim, {
              track: claim.track,
              release: releaseSummary,
              claimant: toStudioPlaylistMemberCredit(
                claim.claimantId,
                memberById.get(claim.claimantId),
              ),
            }),
          ]
        : [];
    });
  }
}
