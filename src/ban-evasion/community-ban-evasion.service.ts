import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { resolveStaffCommunity } from '../communities/community-staff-access';
import { CommunityJoinRequest } from '../communities/entities/community-join-request.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import {
  BanEvasionSignalKind,
  isReviewWorthyTier,
  scoreSignalKinds,
  tierForScore,
} from './ban-evasion-response';
import {
  BAN_EVASION_ESCALATION_RAISED,
  BanEvasionEscalationRaisedEvent,
} from './ban-evasion.events';
import {
  matchKinds,
  BanEvasionService,
  SubjectCorrelationMaterial,
} from './ban-evasion.service';
import {
  CommunityBanEvasionEscalationDTO,
  CommunityBanEvasionFlagDTO,
  toCommunityBanEvasionEscalationDTO,
} from './community-ban-evasion-response';
import {
  BanEvasionEscalation,
  BanEvasionEscalationStatus,
} from './entities/ban-evasion-escalation.entity';
import {
  RemovalKind,
  RemovedAccountSignal,
} from './entities/removed-account-signal.entity';

/**
 * The community-scoped half of ban evasion: one bit for a community's own
 * owner, co-owners and moderators, a button that hands the wider question to
 * platform staff, and the list of questions this community has already asked.
 *
 * THE PRINCIPLE. The community moderator recognises, platform staff
 * investigates. A moderator triaging a join request is told only whether the
 * applicant correlates with somebody THIS community banned, which is knowledge
 * they already hold: they applied that ban themselves. They are told no tier, no
 * score, no matched signal, no hash, no prior account and no date, and nothing
 * whatsoever about another community's bans or a platform-level ban. When their
 * own read says there is more to this, `escalate` puts the case in front of the
 * people who can see the whole picture. Read
 * `CommunityBanEvasionFlagDTO` before changing anything here.
 *
 * HOW THE NARROWING IS ENFORCED. `flagJoinRequests` never builds the wide
 * assessment. The rows it scores against are selected by
 * `communityId = <this community> AND removalKind = 'community_ban'` in the
 * WHERE clause, so a platform ban and another community's ban are never loaded,
 * never scored, and cannot reach the answer by any later edit to the mapping
 * below. There is deliberately nothing here to strip: a mapper that took the
 * full assessment and dropped fields would be one careless refactor away from
 * leaking it, and this repo has no global response serializer to catch that.
 *
 * The MATCHING itself is `matchKinds` and `scoreSignalKinds` from the staff
 * side, unchanged. One matcher and one weighting table, so the bit a moderator
 * sees can never drift away from the assessment staff read on the same person.
 */
@Injectable()
export class CommunityBanEvasionService {
  private readonly logger = new Logger(CommunityBanEvasionService.name);

  constructor(
    @InjectRepository(RemovedAccountSignal)
    private readonly signals: Repository<RemovedAccountSignal>,
    @InjectRepository(BanEvasionEscalation)
    private readonly escalations: Repository<BanEvasionEscalation>,
    @InjectRepository(CommunityJoinRequest)
    private readonly joinRequests: Repository<CommunityJoinRequest>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    private readonly banEvasion: BanEvasionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The badge for a page of the community's join-request queue.
   *
   * BATCHED on purpose. A moderator opens a queue, and a per-request lookup
   * would put an N+1 on the one screen where the whole feature is used.
   *
   * Returns one flag per id that resolved to a join request BELONGING TO THIS
   * COMMUNITY, `false` included, so the client can tell "checked, clear" from
   * "not checked". An id from somebody else's queue simply does not come back.
   */
  async flagJoinRequests(
    slug: string,
    callerUserId: string,
    joinRequestIds: string[],
  ): Promise<CommunityBanEvasionFlagDTO[]> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      callerUserId,
    );
    if (!joinRequestIds.length) return [];

    // Scoped to this community, so the endpoint cannot be used to ask about a
    // join request sitting in another community's queue.
    const requests = await this.joinRequests.find({
      where: { id: In(joinRequestIds), communityId: community.id },
      select: { id: true, userId: true },
    });
    if (!requests.length) return [];

    // THIS community's own bans and nothing else. See the class doc comment.
    const bansHere = await this.signals.find({
      where: {
        communityId: community.id,
        removalKind: RemovalKind.CommunityBan,
      },
    });
    if (!bansHere.length) {
      return requests.map((request) => ({
        joinRequestId: request.id,
        isMatchingBannedMember: false,
      }));
    }

    const applicantIds = [
      ...new Set(requests.map((request) => request.userId)),
    ];
    const materialByUserId = new Map<string, SubjectCorrelationMaterial>();
    const material =
      await this.banEvasion.correlationMaterialForUsers(applicantIds);
    for (const subject of material) {
      materialByUserId.set(subject.subjectId, subject);
    }

    return requests.map((request) => ({
      joinRequestId: request.id,
      isMatchingBannedMember: isMatchingBannedMember(
        materialByUserId.get(request.userId) ?? null,
        bansHere,
      ),
    }));
  }

  /**
   * This community's OWN escalations, newest first.
   *
   * Why it exists: `escalate` is idempotent, so a moderator who already asked
   * needs to be able to SEE that they asked. Without this the triage screen
   * offers the button again on a case already in front of staff, and the second
   * press looks like it did nothing.
   *
   * WHAT IT DOES NOT CARRY. The same boundary as the badge: no assessment, no
   * `resolutionNote`, no `resolvedBy`, no `resolvedAt`. See
   * `CommunityBanEvasionEscalationDTO`. A moderator learns that they asked and
   * whether somebody closed the question, and nothing about what staff found.
   *
   * `status` omitted returns open AND resolved, because the screen needs both:
   * an open one suppresses the button, and a resolved one restores it (the
   * one-open-per-join-request index is partial, so a closed case may be
   * escalated again).
   *
   * Scoped to `communityId` in the WHERE clause. There is no privacy question
   * in a community reading rows its own staff wrote, and the scoping is there
   * so this cannot quietly become a cross-community read later.
   */
  async listEscalations(
    slug: string,
    callerUserId: string,
    status: BanEvasionEscalationStatus | undefined,
  ): Promise<CommunityBanEvasionEscalationDTO[]> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      callerUserId,
    );

    const rows = await this.escalations.find({
      where: {
        communityId: community.id,
        ...(status ? { status } : {}),
      },
      order: { createdAt: 'DESC' },
    });
    // Hand-mapped through the narrow shape, the only mapper this surface has.
    return rows.map((row) => toCommunityBanEvasionEscalationDTO(row));
  }

  /**
   * Hand one join request to platform staff as a ban-evasion question.
   *
   * IDEMPOTENT per (community, join request) while the escalation is open. The
   * `findOne` below only fast-paths the ordinary case: two moderators of the
   * same community pressing the button at the same moment can both miss it, and
   * the partial unique index `UQ_ban_evasion_escalations_open` is what actually
   * closes that race. The loser of the insert re-reads and returns the winner's
   * row, so both moderators see the same escalation. Same shape as
   * `ReportsService.create`'s open-report uniqueness.
   *
   * Once staff resolve it the community may escalate again: a second look after
   * a resolution is worth having, which is why the index is partial.
   *
   * TELLING STAFF is a post-commit event, `BAN_EVASION_ESCALATION_RAISED`, and
   * it fires on the INSERT ONLY. Both idempotent paths below return the existing
   * row and emit nothing, so a moderator pressing the button twice, and two
   * moderators pressing it at once, put one case in front of staff and ping them
   * once about it. Before this event existed the escalation appeared on
   * `/admin/ban-evasion` and pinged nobody, so a question with somebody standing
   * at a door waited for whoever next opened the queue.
   */
  async escalate(
    slug: string,
    callerUserId: string,
    joinRequestId: string,
    note: string | undefined,
  ): Promise<CommunityBanEvasionEscalationDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      callerUserId,
    );

    const request = await this.joinRequests.findOne({
      where: { id: joinRequestId, communityId: community.id },
    });
    if (!request) {
      throw new NotFoundException('Join request not found');
    }

    const existing = await this.findOpenEscalation(community.id, request.id);
    if (existing) return toCommunityBanEvasionEscalationDTO(existing);

    try {
      const saved = await this.escalations.save(
        this.escalations.create({
          communityId: community.id,
          joinRequestId: request.id,
          // Denormalized off the join request so the staff console can assess
          // the applicant without joining back through a row that may have been
          // triaged in the meantime.
          subjectUserId: request.userId,
          raisedByUserId: callerUserId,
          // Plain text, stripped once here at the write boundary.
          note: toStoredPlainTextOrNull(note),
          status: BanEvasionEscalationStatus.Open,
        }),
      );
      // Post-commit, and only here: the two paths that hand back an existing
      // row deliberately stay silent.
      this.emitBestEffort(BAN_EVASION_ESCALATION_RAISED, {
        escalationId: saved.id,
        communityId: community.id,
        joinRequestId: request.id,
        raisedByUserId: callerUserId,
      } satisfies BanEvasionEscalationRaisedEvent);
      return toCommunityBanEvasionEscalationDTO(saved);
    } catch (error) {
      if (isUniqueViolation(error, 'UQ_ban_evasion_escalations_open')) {
        const winner = await this.findOpenEscalation(community.id, request.id);
        if (winner) return toCommunityBanEvasionEscalationDTO(winner);
      }
      throw error;
    }
  }

  /**
   * Emit a domain event WITHOUT letting a synchronous listener failure surface
   * to the caller, the shape `GroupsService.emitBestEffort` and
   * `SocialService.emitBestEffort` already use.
   *
   * The escalation has committed and is on the staff console either way. A
   * notification that fails to go out costs a ping; an escalation that fails
   * because a notification threw costs the moderator the only route they have to
   * ask, on the case they thought urgent enough to ask about.
   */
  private emitBestEffort(eventName: string, payload: unknown): void {
    try {
      this.eventEmitter.emit(eventName, payload);
    } catch (error) {
      this.logger.warn(
        `ban-evasion escalation event ${eventName} could not be emitted: ${String(error)}`,
      );
    }
  }

  private findOpenEscalation(
    communityId: string,
    joinRequestId: string,
  ): Promise<BanEvasionEscalation | null> {
    return this.escalations.findOne({
      where: {
        communityId,
        joinRequestId,
        status: BanEvasionEscalationStatus.Open,
      },
    });
  }
}

/**
 * The one bit, computed from rows that are already narrowed to this community's
 * own bans.
 *
 * `isReviewWorthyTier` is what keeps the badge honest. A shared first name or a
 * single shared inviter reaches `low`, and `low` is not worth telling somebody,
 * flatly and with no room to explain, that the person in front of them looks
 * like a returning banned member. The staff console can show a `low` because it
 * shows WHY beside it. This surface cannot, so it stays quiet.
 */
function isMatchingBannedMember(
  material: SubjectCorrelationMaterial | null,
  bansHere: readonly RemovedAccountSignal[],
): boolean {
  if (!material) return false;

  const kinds: BanEvasionSignalKind[] = [];
  for (const row of bansHere) {
    // A ban row about the applicant's OWN account is not evidence that they are
    // somebody else returning. The join gate already refuses a member this
    // community currently bars; this surface is about a new account behind a
    // familiar person.
    if (
      material.ownRemovedUserId &&
      row.removedUserId === material.ownRemovedUserId
    ) {
      continue;
    }
    kinds.push(...matchKinds(material, row));
  }

  return isReviewWorthyTier(tierForScore(scoreSignalKinds(kinds)));
}
