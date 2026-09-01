import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AdminQueueKey } from '../admin-queue-notifications/admin-queue.registry';
import { isUniqueViolation } from '../common/db-errors';
import { RoadmapItem, RoadmapColumn } from './entities/roadmap-item.entity';
import { RoadmapIdea, RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';
import {
  RoadmapResponse,
  toHeroStatDTO,
  toShippedDTO,
  toBuildingDTO,
  toPlannedDTO,
  toTopIdeaDTO,
  toNotBuildingDTO,
} from './roadmap-response';
import { CastVoteDto } from './dto/cast-vote.dto';
import { SubmitIdeaDto } from './dto/submit-idea.dto';

/**
 * Public reads (`GET /roadmap`), member voting, and idea submission for
 * `/about/roadmap`. Admin CRUD lives in `RoadmapAdminService` — this service
 * never mutates `roadmap_items`/`roadmap_ideas`, only `roadmap_votes`.
 */
@Injectable()
export class RoadmapService {
  constructor(
    @InjectRepository(RoadmapItem)
    private readonly items: Repository<RoadmapItem>,
    @InjectRepository(RoadmapIdea)
    private readonly ideas: Repository<RoadmapIdea>,
    @InjectRepository(RoadmapVote)
    private readonly votes: Repository<RoadmapVote>,
    @InjectRepository(RoadmapSettings)
    private readonly settings: Repository<RoadmapSettings>,
    private readonly adminQueueNotifications: AdminQueueNotificationsService,
  ) {}

  // Real member-vote counts for a batch of targets, keyed by targetId. A
  // target with zero live votes is simply absent from the map (callers
  // `?? 0` the lookup) rather than present with a 0 — cheaper than a LEFT
  // JOIN when most targets have few or no votes.
  private async liveVoteCounts(
    targetType: RoadmapVoteTarget,
    targetIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (targetIds.length === 0) return counts;
    const rows = await this.votes
      .createQueryBuilder('vote')
      .select('vote.targetId', 'targetId')
      .addSelect('COUNT(*)', 'count')
      .where('vote.targetType = :targetType', { targetType })
      .andWhere('vote.targetId IN (:...targetIds)', { targetIds })
      .groupBy('vote.targetId')
      .getRawMany<{ targetId: string; count: string }>();
    for (const row of rows) counts.set(row.targetId, Number(row.count));
    return counts;
  }

  async getPublic(): Promise<RoadmapResponse> {
    // `isPublic`/`archived` gate what an anonymous visitor can see — an item
    // hidden by the admin (isPublic=false) or sent to the Archive view
    // (archived=true) must never appear on `/about/roadmap`, so this is the
    // one place that filter is enforced for the public read.
    const allItems = await this.items.find({
      where: { isPublic: true, archived: false },
      order: { sortOrder: 'ASC' },
    });
    const shipped = allItems.filter(
      (item) => item.column === RoadmapColumn.Shipped,
    );
    const building = allItems.filter(
      (item) => item.column === RoadmapColumn.Building,
    );
    const planned = allItems.filter(
      (item) => item.column === RoadmapColumn.Planned,
    );
    // "Someday" — public backlog-column items, same card shape as `planned`.
    const backlog = allItems.filter(
      (item) => item.column === RoadmapColumn.Backlog,
    );
    const publishedIdeas = await this.ideas.find({
      where: { status: RoadmapIdeaStatus.Published },
      order: { sortOrder: 'ASC' },
    });
    // "Not building this, and why" — dismissed ideas the admin gave a
    // member-facing reason for. A dismissed idea with no `declineReason`
    // (quietly dropped) stays fully internal.
    const notBuildingIdeas = await this.ideas.find({
      where: {
        status: RoadmapIdeaStatus.Dismissed,
        declineReason: Not(IsNull()),
      },
      order: { updatedAt: 'DESC' },
    });
    // One batched vote-count query for both item groups that show a vote
    // count (planned + backlog share the "item" vote target).
    const itemVotes = await this.liveVoteCounts(
      RoadmapVoteTarget.Item,
      [...planned, ...backlog].map((item) => item.id),
    );
    const ideaVotes = await this.liveVoteCounts(
      RoadmapVoteTarget.Idea,
      publishedIdeas.map((idea) => idea.id),
    );
    const notBuildingVotes = await this.liveVoteCounts(
      RoadmapVoteTarget.Idea,
      notBuildingIdeas.map((idea) => idea.id),
    );
    const settings = await this.settings.findOne({ where: { id: 1 } });
    return {
      heroStats: (settings?.heroStats ?? []).map(toHeroStatDTO),
      shipped: shipped.map(toShippedDTO),
      building: building.map(toBuildingDTO),
      planned: planned.map((item) =>
        toPlannedDTO(item, itemVotes.get(item.id) ?? 0),
      ),
      backlog: backlog.map((item) =>
        toPlannedDTO(item, itemVotes.get(item.id) ?? 0),
      ),
      topIdeas: publishedIdeas.map((idea) =>
        toTopIdeaDTO(idea, ideaVotes.get(idea.id) ?? 0),
      ),
      notBuilding: notBuildingIdeas.map((idea) =>
        toNotBuildingDTO(idea, notBuildingVotes.get(idea.id) ?? 0),
      ),
    };
  }

  // Every target id (item or idea) this member has voted for — the frontend
  // uses this to render the caller's own "voted" state without a per-card
  // request.
  async getMyVotes(memberId: string): Promise<string[]> {
    const rows = await this.votes.find({ where: { memberId } });
    return rows.map((row) => row.targetId);
  }

  async castVote(
    memberId: string,
    dto: CastVoteDto,
  ): Promise<{ targetId: string; votes: number; voted: true }> {
    const targetExists =
      dto.targetType === RoadmapVoteTarget.Item
        ? await this.items.exists({ where: { id: dto.targetId } })
        : await this.ideas.exists({ where: { id: dto.targetId } });
    if (!targetExists) {
      throw new NotFoundException(
        dto.targetType === RoadmapVoteTarget.Item
          ? 'Roadmap item not found'
          : 'Roadmap idea not found',
      );
    }

    try {
      await this.votes.save(
        this.votes.create({
          memberId,
          targetType: dto.targetType,
          targetId: dto.targetId,
        }),
      );
    } catch (error) {
      // Idempotent: a repeat vote (or a concurrent one from the same
      // member racing this call) loses on `UQ_roadmap_votes_member_target`
      // — that IS the "already voted" state this call converges on, so
      // swallow it instead of surfacing a 409 the caller can't act on.
      if (!isUniqueViolation(error, 'UQ_roadmap_votes_member_target')) {
        throw error;
      }
    }

    // Recompute the displayed total = seed + live, same formula the public
    // read uses, so the response the caller gets back matches what a
    // fresh `GET /roadmap` would show.
    const seed =
      dto.targetType === RoadmapVoteTarget.Item
        ? ((await this.items.findOne({ where: { id: dto.targetId } }))?.votes ??
          0)
        : ((await this.ideas.findOne({ where: { id: dto.targetId } }))?.votes ??
          0);
    const live =
      (await this.liveVoteCounts(dto.targetType, [dto.targetId])).get(
        dto.targetId,
      ) ?? 0;
    return { targetId: dto.targetId, votes: seed + live, voted: true };
  }

  async submitIdea(
    memberId: string,
    dto: SubmitIdeaDto,
  ): Promise<{ status: 'pending' }> {
    const maxOrder = await this.ideas
      .createQueryBuilder('idea')
      .select('MAX(idea.sortOrder)', 'max')
      .getRawOne<{ max: number | null }>();
    const savedIdea = await this.ideas.save(
      this.ideas.create({
        text: dto.text,
        status: RoadmapIdeaStatus.Pending,
        submittedById: memberId,
        votes: 0,
        sortOrder: (maxOrder?.max ?? -1) + 1,
      }),
    );
    // Tell whoever works the roadmap queue that an idea landed. Awaited, but
    // safe to await: `announce` catches everything internally, so a
    // notification failure can never fail the member's submission. No
    // transaction wraps this write, so the row is already committed by the
    // time this call is reached.
    await this.adminQueueNotifications.announce(
      AdminQueueKey.RoadmapIdeas,
      savedIdea.id,
    );
    return { status: 'pending' };
  }
}
