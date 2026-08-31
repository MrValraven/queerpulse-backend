import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { Community } from '../communities/entities/community.entity';
import { Profile } from '../users/entities/profile.entity';
import { BanEvasionAssessmentDTO } from './ban-evasion-response';
import {
  BAN_EVASION_ESCALATION_RESOLVED,
  BanEvasionEscalationResolvedEvent,
} from './ban-evasion.events';
import { BanEvasionService } from './ban-evasion.service';
import { BanEvasionEscalationDTO } from './community-ban-evasion-response';
import {
  BanEvasionEscalation,
  BanEvasionEscalationStatus,
} from './entities/ban-evasion-escalation.entity';

/**
 * The staff half of an escalation: the queue platform moderators and admins
 * work, on the console where the FULL cross-community assessment already lives.
 *
 * WHY IT LANDS HERE rather than in `src/reports`. A report is a member telling
 * the platform about something that happened. An escalation is a community
 * moderator handing over a question, with no accusation and no subject conduct
 * attached, and filing it as a report would need a system reason code in a
 * taxonomy that exists to describe what members experience. It is a staff work
 * item, and the assessment that answers it is already rendered two routes away
 * on `/admin/ban-evasion`. So it lists there, with the assessment attached
 * inline.
 *
 * THE WIDTH IS THE POINT. `BanEvasionEscalationDTO` carries the tier, the score
 * and every matched signal, across every community and the platform ban list.
 * That is exactly what the escalating moderator does not see, and exactly what
 * they escalated in order to have somebody look at.
 */
@Injectable()
export class BanEvasionEscalationsService {
  private readonly logger = new Logger(BanEvasionEscalationsService.name);

  constructor(
    @InjectRepository(BanEvasionEscalation)
    private readonly escalations: Repository<BanEvasionEscalation>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly banEvasion: BanEvasionService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * The queue, newest first. Defaults to the open ones, which is what staff are
   * on shift for; `status=resolved` reads the history.
   */
  async list(
    status: BanEvasionEscalationStatus = BanEvasionEscalationStatus.Open,
  ): Promise<BanEvasionEscalationDTO[]> {
    const rows = await this.escalations.find({
      where: { status },
      order: { createdAt: 'DESC' },
    });
    return this.toDTOs(rows);
  }

  /**
   * Close one escalation: staff looked, and this is what they found.
   *
   * Resolving also releases the "one open escalation per (community, join
   * request)" lock, so the community may ask again if the applicant comes back.
   * A second resolve is refused rather than silently overwriting the first
   * reviewer's note.
   *
   * TELLING THE MODERATOR WHO ASKED is a post-commit event,
   * `BAN_EVASION_ESCALATION_RESOLVED`. It fires once, on the transition to
   * `resolved`, because the `ConflictException` above means this method can only
   * make that transition once. Before it existed, the raiser could see `status`
   * flip by reopening their own list and nothing ever pushed it: they asked a
   * question and were never told it had been answered.
   *
   * THE EVENT CARRIES NOTHING ABOUT WHAT STAFF FOUND. No `resolutionNote`, no
   * `resolvedByUserId`, no `resolvedAt`, no part of the assessment, and it must
   * never be widened to. The whole point of the escalation is that the
   * cross-community picture stays on this console; handing it back through a
   * bell would deliver by the back door exactly what
   * `CommunityBanEvasionFlagDTO` withholds. See the event's own doc comment.
   */
  async resolve(
    escalationId: string,
    staffUserId: string,
    resolutionNote: string | undefined,
  ): Promise<BanEvasionEscalationDTO> {
    const escalation = await this.escalations.findOne({
      where: { id: escalationId },
    });
    if (!escalation) {
      throw new NotFoundException('Escalation not found');
    }
    if (escalation.status === BanEvasionEscalationStatus.Resolved) {
      throw new ConflictException('This escalation is already resolved');
    }

    escalation.status = BanEvasionEscalationStatus.Resolved;
    escalation.resolvedAt = new Date();
    escalation.resolvedByUserId = staffUserId;
    escalation.resolutionNote = toStoredPlainTextOrNull(resolutionNote);
    const saved = await this.escalations.save(escalation);

    // Post-commit and best effort. The decision is recorded and a second
    // resolve is refused, so a failed ping costs a ping. Read the doc comment
    // above before adding a field: this payload says the case is closed, and
    // says nothing about what closed it.
    this.emitBestEffort(BAN_EVASION_ESCALATION_RESOLVED, {
      escalationId: saved.id,
      communityId: saved.communityId,
      joinRequestId: saved.joinRequestId,
      raisedByUserId: saved.raisedByUserId,
    } satisfies BanEvasionEscalationResolvedEvent);

    const [dto] = await this.toDTOs([saved]);
    if (!dto) {
      // Unreachable: `toDTOs` returns one DTO for every row it is handed.
      // Stated rather than asserted away, so a future change to that method
      // cannot quietly hand a caller an undefined.
      throw new InternalServerErrorException(
        'The resolved escalation could not be rendered',
      );
    }
    return dto;
  }

  /**
   * Emit a domain event WITHOUT letting a synchronous listener failure surface
   * to the caller, the shape `GroupsService.emitBestEffort` and
   * `SocialService.emitBestEffort` already use. The resolution has committed;
   * a notification is never allowed to take a staff decision down with it.
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

  /**
   * Hand-map the rows to the wire shape, resolving the community, the three
   * member references and the assessment in batched lookups for the whole page
   * rather than one round trip per escalation.
   */
  private async toDTOs(
    rows: BanEvasionEscalation[],
  ): Promise<BanEvasionEscalationDTO[]> {
    if (!rows.length) return [];

    const communityIds = unique(rows.map((row) => row.communityId));
    const memberUserIds = unique([
      ...rows.map((row) => row.subjectUserId),
      ...rows.map((row) => row.raisedByUserId),
      ...rows.map((row) => row.resolvedByUserId),
    ]);
    const subjectUserIds = unique(rows.map((row) => row.subjectUserId));

    const [communities, refsByUserId, assessments] = await Promise.all([
      communityIds.length
        ? this.communities.find({
            where: { id: In(communityIds) },
            select: { id: true, slug: true, name: true },
          })
        : Promise.resolve([]),
      new MemberLookup(this.profiles).byUserIds(memberUserIds),
      this.banEvasion.assessUsers(subjectUserIds),
    ]);

    const communityById = new Map(
      communities.map((community) => [community.id, community]),
    );
    const assessmentByUserId = new Map<string, BanEvasionAssessmentDTO>(
      assessments.map((assessment) => [assessment.subjectId, assessment]),
    );

    const refOf = (userId: string | null): MemberRef | null =>
      userId ? (refsByUserId.get(userId) ?? null) : null;

    return rows.map((row) => {
      const community = communityById.get(row.communityId) ?? null;
      return {
        id: row.id,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
        note: row.note,
        communitySlug: community?.slug ?? '',
        communityName: community?.name ?? '',
        joinRequestId: row.joinRequestId,
        subject: refOf(row.subjectUserId),
        raisedBy: refOf(row.raisedByUserId),
        // Null once the applicant's account has been erased, which leaves
        // nothing to correlate.
        assessment: row.subjectUserId
          ? (assessmentByUserId.get(row.subjectUserId) ?? null)
          : null,
        resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
        resolutionNote: row.resolutionNote,
        resolvedBy: refOf(row.resolvedByUserId),
      };
    });
  }
}

/** Deduped, non-null values, so an `IN (:...)` never receives an empty list. */
function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}
