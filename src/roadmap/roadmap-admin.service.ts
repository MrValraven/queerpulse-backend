import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapIdea, RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { RoadmapSettings, HeroStat } from './entities/roadmap-settings.entity';
import {
  RoadmapAdminResponse,
  AdminRoadmapItemDTO,
  AdminRoadmapIdeaDTO,
  toAdminItemDTO,
  toAdminIdeaDTO,
} from './roadmap-admin-response';
import { CreateRoadmapItemDto } from './dto/create-roadmap-item.dto';
import { UpdateRoadmapItemDto } from './dto/update-roadmap-item.dto';
import { SubmitIdeaDto } from './dto/submit-idea.dto';
import { UpdateIdeaDto } from './dto/update-idea.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';

/**
 * Admin CRUD for `/admin/roadmap` — items, ideas (including moderating
 * member-submitted pending ones), and the hero-stats singleton. Public reads
 * + voting live in `RoadmapService`.
 */
@Injectable()
export class RoadmapAdminService {
  constructor(
    @InjectRepository(RoadmapItem) private readonly items: Repository<RoadmapItem>,
    @InjectRepository(RoadmapIdea) private readonly ideas: Repository<RoadmapIdea>,
    @InjectRepository(RoadmapVote) private readonly votes: Repository<RoadmapVote>,
    @InjectRepository(RoadmapSettings) private readonly settings: Repository<RoadmapSettings>,
  ) {}

  // Duplicated (rather than shared) with `RoadmapService`'s identical
  // helper — the two services have no common base class in this module, and
  // the query is small enough that a shared `roadmap-votes.util.ts` isn't
  // worth the indirection for two callers. Revisit if a third one appears.
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

  // All items + all ideas (any status, including `pending` awaiting
  // moderation) + live-vote maps for both, plus the hero-stats singleton.
  async getAdmin(): Promise<RoadmapAdminResponse> {
    const [allItems, allIdeas, settingsRow] = await Promise.all([
      this.items.find({ order: { column: 'ASC', sortOrder: 'ASC' } }),
      this.ideas.find({ order: { sortOrder: 'ASC' } }),
      this.settings.findOne({ where: { id: 1 } }),
    ]);
    const [itemVotes, ideaVotes] = await Promise.all([
      this.liveVoteCounts(RoadmapVoteTarget.Item, allItems.map((item) => item.id)),
      this.liveVoteCounts(RoadmapVoteTarget.Idea, allIdeas.map((idea) => idea.id)),
    ]);
    return {
      items: allItems.map((item) => toAdminItemDTO(item, itemVotes.get(item.id) ?? 0)),
      ideas: allIdeas.map((idea) => toAdminIdeaDTO(idea, ideaVotes.get(idea.id) ?? 0)),
      heroStats: settingsRow?.heroStats ?? [],
    };
  }

  async createItem(dto: CreateRoadmapItemDto): Promise<AdminRoadmapItemDTO> {
    const item = await this.items.save(this.items.create(dto));
    return toAdminItemDTO(item, 0);
  }

  async updateItem(id: string, dto: UpdateRoadmapItemDto): Promise<AdminRoadmapItemDTO> {
    const item = await this.loadItemOr404(id);
    Object.assign(item, dto);
    const saved = await this.items.save(item);
    const liveVotes = (await this.liveVoteCounts(RoadmapVoteTarget.Item, [id])).get(id) ?? 0;
    return toAdminItemDTO(saved, liveVotes);
  }

  async deleteItem(id: string): Promise<void> {
    const item = await this.loadItemOr404(id);
    await this.items.remove(item);
  }

  // Admin-authored ideas skip the `pending` review step other members'
  // submissions go through — they're published directly, with no attributed
  // submitter (`fromMember: false` on the resulting DTO).
  async createIdea(dto: SubmitIdeaDto): Promise<AdminRoadmapIdeaDTO> {
    const maxOrder = await this.ideas
      .createQueryBuilder('idea')
      .select('MAX(idea.sortOrder)', 'max')
      .getRawOne<{ max: number | null }>();
    const idea = await this.ideas.save(
      this.ideas.create({
        text: dto.text,
        status: RoadmapIdeaStatus.Published,
        submittedById: null,
        votes: 0,
        sortOrder: (maxOrder?.max ?? -1) + 1,
      }),
    );
    return toAdminIdeaDTO(idea, 0);
  }

  // Edits text/status/sortOrder/votes. Promoting a pending member idea sets
  // `status: published` (it then appears in the public "Top ideas" list);
  // dismissing sets `status: dismissed` (hidden from the public list, kept
  // for the audit trail).
  async updateIdea(id: string, dto: UpdateIdeaDto): Promise<AdminRoadmapIdeaDTO> {
    const idea = await this.loadIdeaOr404(id);
    Object.assign(idea, dto);
    const saved = await this.ideas.save(idea);
    const liveVotes = (await this.liveVoteCounts(RoadmapVoteTarget.Idea, [id])).get(id) ?? 0;
    return toAdminIdeaDTO(saved, liveVotes);
  }

  async deleteIdea(id: string): Promise<void> {
    const idea = await this.loadIdeaOr404(id);
    await this.ideas.remove(idea);
  }

  // Upserts the `roadmap_settings` singleton (id = 1) — mirrors
  // `GovernanceOverview`/`ChangemakerDirectorySettings`'s "no authoring
  // endpoint beyond an admin edit" singleton pattern.
  async updateSettings(dto: UpdateSettingsDto): Promise<{ heroStats: HeroStat[] }> {
    let row = await this.settings.findOne({ where: { id: 1 } });
    if (!row) row = this.settings.create({ id: 1, heroStats: [] });
    row.heroStats = dto.heroStats;
    await this.settings.save(row);
    return { heroStats: row.heroStats };
  }

  private async loadItemOr404(id: string): Promise<RoadmapItem> {
    const item = await this.items.findOne({ where: { id } });
    if (!item) throw new NotFoundException('Roadmap item not found');
    return item;
  }

  private async loadIdeaOr404(id: string): Promise<RoadmapIdea> {
    const idea = await this.ideas.findOne({ where: { id } });
    if (!idea) throw new NotFoundException('Roadmap idea not found');
    return idea;
  }
}
