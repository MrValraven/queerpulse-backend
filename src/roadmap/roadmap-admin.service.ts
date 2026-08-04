import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, LessThan, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  RoadmapItem,
  RoadmapColumn,
  RoadmapPriority,
  RoadmapConfidence,
  RoadmapPaidKind,
  RoadmapCost,
} from './entities/roadmap-item.entity';
import { RoadmapIdea, RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import { RoadmapVote, RoadmapVoteTarget } from './entities/roadmap-vote.entity';
import { RoadmapSettings, HeroStat } from './entities/roadmap-settings.entity';
import { RoadmapTeamMember } from './entities/roadmap-team-member.entity';
import { RoadmapItemComment } from './entities/roadmap-item-comment.entity';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';
import { RoadmapItemDependency } from './entities/roadmap-item-dependency.entity';
import {
  RoadmapAdminResponse,
  AdminRoadmapItemDTO,
  AdminRoadmapIdeaDTO,
  AdminItemCommentDTO,
  AdminItemExtras,
  RoadmapTeamMemberDTO,
  RoadmapAuditEntryDTO,
  toAdminItemDTO,
  toAdminIdeaDTO,
  toTeamMemberDTO,
  toAuditEntryDTO,
} from './roadmap-admin-response';
import { CreateRoadmapItemDto } from './dto/create-roadmap-item.dto';
import { UpdateRoadmapItemDto } from './dto/update-roadmap-item.dto';
import { SubmitIdeaDto } from './dto/submit-idea.dto';
import { UpdateIdeaDto } from './dto/update-idea.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { BulkItemsDto } from './dto/bulk-items.dto';
import { NotifyVotersDto } from './dto/notify-voters.dto';
import { UpdateDepsDto } from './dto/update-deps.dto';
import { DeclineIdeaDto } from './dto/decline-idea.dto';
import { MergeIdeaDto } from './dto/merge-idea.dto';
import {
  CreateTeamMemberDto,
  UpdateTeamMemberDto,
} from './dto/team-member.dto';
import { logAudit } from './roadmap-audit.util';
import { computeVoteBreakdown } from './roadmap-vote-breakdown.util';

/**
 * Who performed an admin roadmap action — derived by the controller (Task
 * A7) from `@CurrentUser()` and threaded into every mutator below so it can
 * be recorded on `slips`/the audit trail. Every mutator's `actor` parameter
 * is optional (not because an anonymous admin action is meaningful, but
 * because the controller doesn't supply one until A7 wires it) — an omitted
 * actor still writes a valid, system-attributed audit row (`actorId: null`,
 * `actorLabel: 'System'`) rather than throwing. See `RoadmapAdminService.audit`.
 */
export interface RoadmapActor {
  actorId: string;
  actorLabel: string;
}

/**
 * Admin CRUD for `/admin/roadmap` — items (including the slip/safety guards,
 * dependencies, duplication, archiving, voter notifications, and bulk
 * actions), ideas (including moderating member-submitted pending ones), team
 * roster, audit trail, and the hero-stats singleton. Public reads + voting
 * live in `RoadmapService`.
 */
@Injectable()
export class RoadmapAdminService {
  constructor(
    @InjectRepository(RoadmapItem)
    private readonly items: Repository<RoadmapItem>,
    @InjectRepository(RoadmapIdea)
    private readonly ideas: Repository<RoadmapIdea>,
    @InjectRepository(RoadmapVote)
    private readonly votes: Repository<RoadmapVote>,
    @InjectRepository(RoadmapSettings)
    private readonly settings: Repository<RoadmapSettings>,
    @InjectRepository(RoadmapTeamMember)
    private readonly team: Repository<RoadmapTeamMember>,
    @InjectRepository(RoadmapItemComment)
    private readonly comments: Repository<RoadmapItemComment>,
    @InjectRepository(RoadmapItemDependency)
    private readonly deps: Repository<RoadmapItemDependency>,
    @InjectRepository(RoadmapAuditLog)
    private readonly auditLog: Repository<RoadmapAuditLog>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    private readonly notifications: NotificationsService,
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

  private nameOf(ref: MemberRef | undefined): string | null {
    return ref ? `${ref.firstName} ${ref.lastName}`.trim() : null;
  }

  private toCommentDTO(comment: RoadmapItemComment): AdminItemCommentDTO {
    return {
      id: comment.id,
      authorLabel: comment.authorLabel,
      body: comment.body,
      hidden: comment.hidden,
      createdAt: comment.createdAt.toISOString(),
    };
  }

  /**
   * Best-effort audit-trail write — every mutator below calls this AFTER its
   * own write succeeds (or, for multi-row transactions, from inside the same
   * `manager.transaction` callback, via the `manager` param, so the audit row
   * commits/rolls back atomically with the mutation). Swallows any error:
   * `roadmap-audit.util.ts#logAudit` itself does not, by design, so the
   * try/catch has to live at the call site — this is that one call site,
   * shared by every mutator instead of each repeating it.
   */
  private async audit(
    actor: RoadmapActor | undefined,
    action: string,
    manager: EntityManager = this.items.manager,
  ): Promise<void> {
    try {
      await logAudit(manager, {
        actorId: actor?.actorId ?? null,
        actorLabel: actor?.actorLabel ?? 'System',
        action,
      });
    } catch {
      // Intentionally ignored — the mutation this documents already
      // committed (or, inside a transaction, this call itself is the last
      // statement, so a failure here would otherwise take the whole
      // mutation down with it).
    }
  }

  // The computed/joined extras (`liveVotes`/`ownerName`/`voteBreakdown`/
  // `comments`/`deps`) for ONE item — used by every single-item mutator's
  // return value. `getAdmin()` below computes the same shape batched across
  // every item in one pass instead of calling this per row (would be an
  // N+1 across `users`/`roadmap_votes`/`roadmap_item_comments`/
  // `roadmap_item_dependencies`).
  private async buildItemExtras(item: RoadmapItem): Promise<AdminItemExtras> {
    const [liveVotes, breakdown, comments, itemDeps, ownerRefs] =
      await Promise.all([
        this.liveVoteCounts(RoadmapVoteTarget.Item, [item.id]),
        computeVoteBreakdown(
          this.votes,
          this.communityMembers,
          RoadmapVoteTarget.Item,
          [item.id],
        ),
        this.comments.find({
          where: { itemId: item.id },
          order: { createdAt: 'ASC' },
        }),
        this.deps.find({ where: { itemId: item.id } }),
        new MemberLookup(this.profiles).byUserIds(
          item.ownerId ? [item.ownerId] : [],
        ),
      ]);
    return {
      liveVotes: liveVotes.get(item.id) ?? 0,
      ownerName: item.ownerId ? this.nameOf(ownerRefs.get(item.ownerId)) : null,
      voteBreakdown: breakdown.get(item.id) ?? { top: [], other: 0 },
      comments: comments.map((comment) => this.toCommentDTO(comment)),
      deps: itemDeps.map((dep) => dep.dependsOnId),
    };
  }

  // All items (any column, including archived — the UI filters archived,
  // not this query) + all ideas (any status, including `pending` awaiting
  // moderation) + the team roster + the 100 most recent audit entries +
  // live-vote maps/vote breakdowns/comments/deps for items, batched — no
  // N+1 across `users`/`roadmap_votes`/`roadmap_item_comments`/
  // `roadmap_item_dependencies` regardless of board size.
  async getAdmin(): Promise<RoadmapAdminResponse> {
    const [allItems, allIdeas, teamRows, auditRows, settingsRow] =
      await Promise.all([
        this.items.find({ order: { column: 'ASC', sortOrder: 'ASC' } }),
        this.ideas.find({ order: { sortOrder: 'ASC' } }),
        this.team.find({ order: { sortOrder: 'ASC' } }),
        this.auditLog.find({ order: { createdAt: 'DESC' }, take: 100 }),
        this.settings.findOne({ where: { id: 1 } }),
      ]);

    const itemIds = allItems.map((item) => item.id);
    const ideaIds = allIdeas.map((idea) => idea.id);

    const [itemVotes, ideaVotes, voteBreakdowns, allComments, allDeps] =
      await Promise.all([
        this.liveVoteCounts(RoadmapVoteTarget.Item, itemIds),
        this.liveVoteCounts(RoadmapVoteTarget.Idea, ideaIds),
        computeVoteBreakdown(
          this.votes,
          this.communityMembers,
          RoadmapVoteTarget.Item,
          itemIds,
        ),
        itemIds.length
          ? this.comments.find({
              where: { itemId: In(itemIds) },
              order: { createdAt: 'ASC' },
            })
          : Promise.resolve([]),
        itemIds.length
          ? this.deps.find({ where: { itemId: In(itemIds) } })
          : Promise.resolve([]),
      ]);

    const commentsByItem = new Map<string, AdminItemCommentDTO[]>();
    for (const comment of allComments) {
      const list = commentsByItem.get(comment.itemId) ?? [];
      list.push(this.toCommentDTO(comment));
      commentsByItem.set(comment.itemId, list);
    }

    const depsByItem = new Map<string, string[]>();
    for (const dep of allDeps) {
      const list = depsByItem.get(dep.itemId) ?? [];
      list.push(dep.dependsOnId);
      depsByItem.set(dep.itemId, list);
    }

    // Owner names (items) + team member names, resolved from `users` in ONE
    // batched query shared by both.
    const ownerIds = allItems
      .map((item) => item.ownerId)
      .filter((ownerId): ownerId is string => ownerId !== null);
    const teamUserIds = teamRows.map((member) => member.userId);
    const nameRefs = await new MemberLookup(this.profiles).byUserIds([
      ...new Set([...ownerIds, ...teamUserIds]),
    ]);

    const items = allItems.map((item) =>
      toAdminItemDTO(item, {
        liveVotes: itemVotes.get(item.id) ?? 0,
        ownerName: item.ownerId
          ? this.nameOf(nameRefs.get(item.ownerId))
          : null,
        voteBreakdown: voteBreakdowns.get(item.id) ?? { top: [], other: 0 },
        comments: commentsByItem.get(item.id) ?? [],
        deps: depsByItem.get(item.id) ?? [],
      }),
    );
    const ideas = allIdeas.map((idea) =>
      toAdminIdeaDTO(idea, ideaVotes.get(idea.id) ?? 0),
    );
    const team = teamRows.map((member) =>
      toTeamMemberDTO(member, this.nameOf(nameRefs.get(member.userId)) ?? ''),
    );
    const audit = auditRows.map(toAuditEntryDTO);

    return {
      items,
      ideas,
      team,
      audit,
      heroStats: settingsRow?.heroStats ?? [],
    };
  }

  async createItem(
    dto: CreateRoadmapItemDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    // Safety guard — same invariant as `updateItem`: can't create an item
    // already public while a required safety review hasn't cleared.
    if (dto.isPublic && dto.safetyStatus === 1) {
      throw new BadRequestException(
        'This item needs its safety review cleared before it can go public',
      );
    }
    const item = await this.items.save(this.items.create(dto));
    await this.audit(actor, `Created "${item.name}"`);
    return toAdminItemDTO(item, await this.buildItemExtras(item));
  }

  async updateItem(
    id: string,
    dto: UpdateRoadmapItemDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const item = await this.loadItemOr404(id);

    // Slip guard — a `targetQuarter` change on a card that hasn't shipped
    // must carry a reason, appended to `slips` (never silently overwritten).
    // A shipped card's `targetQuarter` is historical record, not a live
    // promise, so it's exempt.
    if (
      dto.targetQuarter !== undefined &&
      dto.targetQuarter !== item.targetQuarter &&
      item.column !== RoadmapColumn.Shipped
    ) {
      if (!dto.slipReason) {
        throw new BadRequestException(
          'slipReason is required when targetQuarter changes on a card that has not shipped',
        );
      }
      item.slips = [
        ...item.slips,
        {
          from: item.targetQuarter ?? '',
          to: dto.targetQuarter ?? '',
          reason: dto.slipReason,
          movedByName: actor?.actorLabel ?? 'System',
          movedAt: new Date().toISOString(),
        },
      ];
    }

    // `slipReason` isn't a mapped column — TypeORM's `save()` only persists
    // entity columns, so carrying it through onto `item` here is harmless.
    Object.assign(item, dto);

    // Prototype invariant: a card that lands in `shipped` is done, full
    // stop — its progress bar always reads 100, regardless of what (if
    // anything) the caller sent for `progress`.
    if (item.column === RoadmapColumn.Shipped) {
      item.progress = 100;
    }

    // Safety guard — can't surface publicly while a required safety review
    // hasn't cleared. Checked against the POST-merge state so it catches
    // both "publish while already gated" and "gate while already public".
    if (item.isPublic && item.safetyStatus === 1) {
      throw new BadRequestException(
        'This item needs its safety review cleared before it can go public',
      );
    }

    const saved = await this.items.save(item);
    await this.audit(actor, `Updated "${saved.name}"`);
    return toAdminItemDTO(saved, await this.buildItemExtras(saved));
  }

  async deleteItem(id: string, actor?: RoadmapActor): Promise<void> {
    const item = await this.loadItemOr404(id);
    // Votes are polymorphic (`target_id` has no FK to discriminate item vs
    // idea — see the migration), so nothing cascades them. Delete this item's
    // votes and the item itself in one transaction to avoid orphaned
    // `roadmap_votes` rows (which would otherwise inflate a re-created item's
    // count if an id were ever reused, and leak into `getMyVotes`). Comments
    // and dependency edges DO cascade at the DB layer (`ON DELETE CASCADE`
    // on `item_id`/`depends_on_id`, migration `AddRoadmapAdminModel`), so
    // they need no explicit cleanup here.
    await this.items.manager.transaction(async (manager) => {
      await manager.delete(RoadmapVote, {
        targetType: RoadmapVoteTarget.Item,
        targetId: id,
      });
      await manager.delete(RoadmapItem, { id });
      await this.audit(actor, `Deleted "${item.name}"`, manager);
    });
  }

  async updateDeps(
    id: string,
    dto: UpdateDepsDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const item = await this.loadItemOr404(id);

    if (dto.add) {
      if (dto.add === id) {
        throw new BadRequestException('An item cannot depend on itself');
      }
      const dependsOnExists = await this.items.exists({
        where: { id: dto.add },
      });
      if (!dependsOnExists) {
        throw new NotFoundException('Dependency target item not found');
      }
    }

    await this.items.manager.transaction(async (manager) => {
      const depRepo = manager.getRepository(RoadmapItemDependency);
      if (dto.add) {
        try {
          await depRepo.save(
            depRepo.create({ itemId: id, dependsOnId: dto.add }),
          );
        } catch (error) {
          // Already depends on it — idempotent, matches `castVote`'s idiom
          // for a repeat/racing write against a unique constraint.
          if (!isUniqueViolation(error, 'UQ_roadmap_item_dependencies_pair')) {
            throw error;
          }
        }
      }
      if (dto.remove) {
        await depRepo.delete({ itemId: id, dependsOnId: dto.remove });
      }
      await this.audit(
        actor,
        `Updated dependencies on "${item.name}"`,
        manager,
      );
    });

    return toAdminItemDTO(item, await this.buildItemExtras(item));
  }

  async duplicateItem(
    id: string,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const original = await this.loadItemOr404(id);

    const duplicate = await this.items.manager.transaction(async (manager) => {
      const itemRepo = manager.getRepository(RoadmapItem);
      const maxOrder = await itemRepo
        .createQueryBuilder('item')
        .select('MAX(item.sortOrder)', 'max')
        .where('item.column = :column', { column: original.column })
        .getRawOne<{ max: number | null }>();

      const created = await itemRepo.save(
        itemRepo.create({
          column: original.column,
          category: original.category,
          name: `${original.name} (copy)`,
          description: original.description,
          publicNote: original.publicNote,
          date: original.date,
          stage: original.stage,
          eta: original.eta,
          targetQuarter: original.targetQuarter,
          progress: original.progress,
          priority: original.priority,
          confidence: original.confidence,
          // A duplicate is a fresh draft, not a re-announcement of the
          // original's public promise — starts private/uncommitted/
          // un-notified/un-archived with no slip history of its own.
          committed: false,
          isPublic: false,
          requested: original.requested,
          notified: false,
          spikeFlag: original.spikeFlag,
          safetyStatus: original.safetyStatus,
          blockedBy: original.blockedBy,
          blockedWhy: original.blockedWhy,
          paidKind: original.paidKind,
          weeklyHours: original.weeklyHours,
          cost: original.cost,
          ownerId: original.ownerId,
          slips: [],
          guide: original.guide,
          votes: 0,
          hot: false,
          archived: false,
          sortOrder: (maxOrder?.max ?? -1) + 1,
        }),
      );

      const depRepo = manager.getRepository(RoadmapItemDependency);
      const originalDeps = await depRepo.find({ where: { itemId: id } });
      if (originalDeps.length > 0) {
        await depRepo.save(
          originalDeps.map((dep) =>
            depRepo.create({
              itemId: created.id,
              dependsOnId: dep.dependsOnId,
            }),
          ),
        );
      }

      await this.audit(
        actor,
        `Duplicated "${original.name}" as "${created.name}"`,
        manager,
      );
      return created;
    });

    return toAdminItemDTO(duplicate, await this.buildItemExtras(duplicate));
  }

  async archiveItem(
    id: string,
    archived: boolean,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const item = await this.loadItemOr404(id);
    item.archived = archived;
    const saved = await this.items.save(item);
    await this.audit(
      actor,
      `${archived ? 'Archived' : 'Restored'} "${saved.name}"`,
    );
    return toAdminItemDTO(saved, await this.buildItemExtras(saved));
  }

  // Best-effort notification blast to every member who voted for this item.
  // Reuses `NotificationsService.createForRecipients`'s own block/mute
  // filtering (passing `actor.actorId` as the acting member, same as any
  // other admin-initiated fan-out) so the RETURNED count already reflects
  // suppressed recipients, not just "how many voters exist".
  async notifyVoters(
    id: string,
    dto: NotifyVotersDto,
    actor?: RoadmapActor,
  ): Promise<{ notified: number }> {
    const item = await this.loadItemOr404(id);
    const voteRows = await this.votes.find({
      where: { targetType: RoadmapVoteTarget.Item, targetId: id },
    });
    const voterIds = voteRows.map((vote) => vote.memberId);

    let notified = 0;
    if (voterIds.length > 0) {
      try {
        const recipientIds = await this.notifications.createForRecipients(
          voterIds,
          NotificationType.RoadmapStatus,
          { source: 'roadmap', itemId: id, message: dto.message },
          actor?.actorId,
        );
        notified = recipientIds.length;
      } catch {
        // Best-effort — the item is still marked `notified` below even if
        // the fan-out failed partway; a moderator can always re-send.
      }
    }

    item.notified = true;
    const saved = await this.items.save(item);
    await this.audit(actor, `Notified ${notified} voter(s) on "${saved.name}"`);
    return { notified };
  }

  async bulkItems(
    dto: BulkItemsDto,
    actor?: RoadmapActor,
  ): Promise<{ count: number }> {
    if (dto.action === 'move' && !dto.column) {
      throw new BadRequestException('column is required for the "move" action');
    }

    const count = await this.items.manager.transaction(async (manager) => {
      const itemRepo = manager.getRepository(RoadmapItem);
      const targets = await itemRepo.find({ where: { id: In(dto.ids) } });
      if (targets.length === 0) return 0;
      const ids = targets.map((target) => target.id);
      // Defaults to the full selection; `'show'` narrows this to the subset
      // actually written (safety-gated items are skipped, not failed) — see
      // below. This is what both the returned `{ count }` and the audit
      // message report, never the raw selection size.
      let affected = targets.length;

      switch (dto.action) {
        case 'move': {
          // Guaranteed defined: validated above, before the transaction
          // opened — TypeScript can't carry that narrowing into this nested
          // closure, hence the assertion rather than a redundant re-check.
          const column = dto.column!;
          await itemRepo.update(
            { id: In(ids) },
            {
              column,
              // Prototype invariant, bulk form: moving into `shipped`
              // always sets progress to 100 — the bulk body has no
              // `progress` field, so this is the only place that can
              // enforce it for a bulk move.
              ...(column === RoadmapColumn.Shipped ? { progress: 100 } : {}),
            },
          );
          break;
        }
        case 'show': {
          // Safety guard, bulk form: silently skip items still gated by an
          // uncleared safety review rather than failing the whole batch —
          // and count/audit only the ones actually made public.
          const allowedIds = targets
            .filter((target) => target.safetyStatus !== 1)
            .map((target) => target.id);
          affected = allowedIds.length;
          if (allowedIds.length > 0) {
            await itemRepo.update({ id: In(allowedIds) }, { isPublic: true });
          }
          break;
        }
        case 'hide':
          await itemRepo.update({ id: In(ids) }, { isPublic: false });
          break;
        case 'archive':
          await itemRepo.update({ id: In(ids) }, { archived: true });
          break;
        case 'delete':
          // Comments/dependency edges cascade at the DB layer — only votes
          // need explicit cleanup here, same as `deleteItem`.
          await manager.delete(RoadmapVote, {
            targetType: RoadmapVoteTarget.Item,
            targetId: In(ids),
          });
          await itemRepo.delete({ id: In(ids) });
          break;
      }

      await this.audit(
        actor,
        `Bulk ${dto.action} on ${affected} item(s)`,
        manager,
      );
      return affected;
    });

    return { count };
  }

  // Admin-authored ideas skip the `pending` review step other members'
  // submissions go through — they're published directly, with no attributed
  // submitter (`fromMember: false` on the resulting DTO).
  async createIdea(
    dto: SubmitIdeaDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapIdeaDTO> {
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
    await this.audit(actor, `Created idea "${idea.text}"`);
    return toAdminIdeaDTO(idea, 0);
  }

  // Edits text/status/sortOrder/votes. Promoting a pending member idea sets
  // `status: published` (it then appears in the public "Top ideas" list);
  // dismissing sets `status: dismissed` (hidden from the public list, kept
  // for the audit trail). Moving BACK to `published` (reopening a declined
  // idea, either via this generic patch or via the dedicated flows below)
  // clears `declineReason`/`declineNote` — a reopened idea must not still
  // read as "not building" on the public page, which surfaces dismissed
  // ideas with a `declineReason` set.
  async updateIdea(
    id: string,
    dto: UpdateIdeaDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapIdeaDTO> {
    const idea = await this.loadIdeaOr404(id);
    const previousStatus = idea.status;
    Object.assign(idea, dto);
    if (dto.status === RoadmapIdeaStatus.Published) {
      idea.declineReason = null;
      idea.declineNote = null;
    }
    const saved = await this.ideas.save(idea);
    await this.audit(actor, `Updated idea "${saved.text}"`);
    // Tell the member who submitted this idea that its status changed (e.g.
    // pending → published, or → dismissed). Only when there's a real submitter
    // and the status genuinely moved. No actor: an admin decision reads as the
    // platform's word, not a member action. Best-effort; deep-links to the
    // public roadmap. Admin-authored ideas have `submittedById: null` and so
    // never notify.
    if (saved.submittedById && saved.status !== previousStatus) {
      try {
        await this.notifications.create(
          saved.submittedById,
          NotificationType.RoadmapStatus,
          { source: 'roadmap', ideaId: saved.id, status: saved.status },
        );
      } catch {
        // Intentionally ignored — the idea update already committed.
      }
    }
    const liveVotes =
      (await this.liveVoteCounts(RoadmapVoteTarget.Idea, [id])).get(id) ?? 0;
    return toAdminIdeaDTO(saved, liveVotes);
  }

  async deleteIdea(id: string, actor?: RoadmapActor): Promise<void> {
    const idea = await this.loadIdeaOr404(id);
    // Same polymorphic-vote cleanup as `deleteItem` — delete the idea's votes
    // and the idea in one transaction so no orphaned `roadmap_votes` remain.
    await this.ideas.manager.transaction(async (manager) => {
      await manager.delete(RoadmapVote, {
        targetType: RoadmapVoteTarget.Idea,
        targetId: id,
      });
      await manager.delete(RoadmapIdea, { id });
      await this.audit(actor, `Deleted idea "${idea.text}"`, manager);
    });
  }

  // Turns a pending/published idea into a real backlog card: creates a new
  // `RoadmapItem` seeded from the idea's text/category/votes, then removes
  // the idea entirely (its own votes cleaned up in the same transaction as
  // `deleteIdea`/`deleteItem` do — nothing cascades a polymorphic
  // `roadmap_votes` row). The idea's OWN live votes are simply dropped here
  // (not moved) — a promoted idea becomes a fresh backlog card starting at
  // its seed `votes` count, distinct from `mergeIdea` below, which folds an
  // idea into an EXISTING item and so must carry live votes forward to avoid
  // silently erasing member support already on the record.
  //
  // Concurrency: mirrors `mergeIdea`'s fix — the ENTIRE read-modify-write
  // runs inside ONE `manager.transaction`, with the idea re-loaded via the
  // transactional `manager` under a `pessimistic_write` lock before anything
  // else happens. Nothing is read from the plain `ideas` repository before
  // the transaction opens (the old `loadIdeaOr404` pre-transaction snapshot
  // is exactly what let two concurrent promotes — or a promote racing
  // `mergeIdea`/`declineIdea`'s deletes — each build a `RoadmapItem` off a
  // stale idea that had already been consumed). If a concurrent request won
  // the race, this transaction blocks on the lock until that one commits,
  // then sees the idea already gone and 404s instead of double-creating.
  async promoteIdea(
    id: string,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const { item, notifySubmitterId } = await this.items.manager.transaction(
      async (manager) => {
        const idea = await manager.findOne(RoadmapIdea, {
          where: { id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!idea) {
          // Already promoted/merged/declined-and-deleted by a concurrent
          // request — no-op gracefully rather than creating a second item
          // from data this transaction never actually locked.
          throw new NotFoundException('Roadmap idea not found');
        }

        const itemRepo = manager.getRepository(RoadmapItem);
        const maxOrder = await itemRepo
          .createQueryBuilder('item')
          .select('MAX(item.sortOrder)', 'max')
          .where('item.column = :column', { column: RoadmapColumn.Planned })
          .getRawOne<{ max: number | null }>();

        const created = await itemRepo.save(
          itemRepo.create({
            column: RoadmapColumn.Planned,
            category: idea.category,
            name: idea.text,
            description: '',
            publicNote: null,
            date: null,
            stage: null,
            eta: null,
            targetQuarter: null,
            progress: null,
            priority: RoadmapPriority.P2,
            confidence: RoadmapConfidence.Maybe,
            committed: false,
            isPublic: true,
            requested: true,
            notified: false,
            spikeFlag: false,
            safetyStatus: 0,
            blockedBy: null,
            blockedWhy: null,
            paidKind: RoadmapPaidKind.Volunteer,
            weeklyHours: 0,
            cost: RoadmapCost.None,
            ownerId: null,
            slips: [],
            guide: null,
            votes: idea.votes,
            hot: false,
            archived: false,
            sortOrder: (maxOrder?.max ?? -1) + 1,
          }),
        );

        await manager.delete(RoadmapVote, {
          targetType: RoadmapVoteTarget.Idea,
          targetId: id,
        });
        await manager.delete(RoadmapIdea, { id });

        await this.audit(
          actor,
          `Promoted idea "${idea.text}" to item "${created.name}"`,
          manager,
        );
        return { item: created, notifySubmitterId: idea.submittedById };
      },
    );

    if (notifySubmitterId) {
      try {
        await this.notifications.create(
          notifySubmitterId,
          NotificationType.RoadmapStatus,
          { source: 'roadmap', itemId: item.id, status: 'promoted' },
        );
      } catch {
        // Best-effort — the promotion already committed.
      }
    }

    return toAdminItemDTO(item, {
      liveVotes: 0,
      ownerName: null,
      voteBreakdown: { top: [], other: 0 },
      comments: [],
      deps: [],
    });
  }

  // Folds a pending idea into an EXISTING item: moves the idea's live votes
  // onto the target, bumps the target's seed `votes` by the idea's seed
  // count, flags the target `requested: true` (this merge IS a request
  // signal even if the target wasn't flagged as one yet), and deletes the
  // idea + its votes. Fix-round 1 (concurrency): the ENTIRE read-modify-write
  // now happens inside ONE `manager.transaction`, using the transactional
  // `manager` throughout — nothing is read from the plain repositories
  // before the transaction opens, which is what let the four races below
  // through the first time:
  //   1. A stale pre-transaction snapshot of the target's existing voters
  //      could go stale by the time votes were reassigned, so an `UPDATE
  //      targetId` could still 23505 against `UQ_roadmap_votes_member_target`
  //      and throw an unhandled 500. Fixed by dropping the snapshot and
  //      instead trying the reassignment per vote, catching that exact
  //      constraint violation (`isUniqueViolation`, same idiom `updateDeps`
  //      uses) and deleting the idea-side vote on collision.
  //   2. Reading `target` outside the transaction and `.save()`-ing the
  //      whole (possibly stale) entity back could clobber a concurrent edit
  //      to some OTHER field on the target. Fixed with a targeted
  //      `manager.increment(..., 'votes', …)` + `manager.update(...,
  //      { requested: true })` instead of a read-modify-save round trip.
  //   3. The idea itself was never re-validated inside the transaction, so
  //      two concurrent merges of the SAME idea could both add its seed
  //      votes. Fixed with a `pessimistic_write` lock on the idea row
  //      (mirrors `subprofile-invites.service`/`rsvp.service`'s idiom for
  //      the same "close a concurrent double-apply" shape) — the second
  //      transaction blocks until the first commits, then sees the idea
  //      already gone and no-ops instead of double-counting.
  //   4. A consequence of #3: because the idea's vote rows are now read
  //      AFTER the lock is held (not snapshotted pre-transaction), the final
  //      `roadmap_votes` cleanup below only removes what was captured at
  //      that point — see its own comment for why that's an acceptable
  //      trade-off, not a bug.
  async mergeIdea(
    id: string,
    dto: MergeIdeaDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapItemDTO> {
    const result = await this.items.manager.transaction(async (manager) => {
      const target = await manager.findOne(RoadmapItem, {
        where: { id: dto.intoItemId },
      });
      if (!target) {
        throw new NotFoundException('Merge target item not found');
      }

      // Lock the idea row before touching anything else about it. If a
      // concurrent request already promoted/merged/declined-and-deleted
      // this idea, it's simply gone by the time this transaction gets the
      // lock — no-op the rest and return the target untouched rather than
      // double-applying its seed votes.
      const idea = await manager.findOne(RoadmapIdea, {
        where: { id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!idea) {
        return { item: target, notifySubmitterId: null };
      }

      const voteRepo = manager.getRepository(RoadmapVote);
      const ideaVoteRows = await voteRepo.find({
        where: { targetType: RoadmapVoteTarget.Idea, targetId: id },
      });
      for (const vote of ideaVoteRows) {
        try {
          await voteRepo.update(
            { id: vote.id },
            { targetType: RoadmapVoteTarget.Item, targetId: target.id },
          );
        } catch (error) {
          if (!isUniqueViolation(error, 'UQ_roadmap_votes_member_target')) {
            throw error;
          }
          // This member already has a live vote on the target item
          // directly — reassigning collided with the unique (memberId,
          // targetType, targetId) constraint. Drop the idea-side vote
          // instead of double-counting the same member.
          await voteRepo.delete({ id: vote.id });
        }
      }

      await manager.increment(
        RoadmapItem,
        { id: target.id },
        'votes',
        idea.votes,
      );
      await manager.update(RoadmapItem, { id: target.id }, { requested: true });
      const savedTarget = await manager.findOne(RoadmapItem, {
        where: { id: target.id },
      });
      if (!savedTarget) {
        throw new NotFoundException('Merge target item not found');
      }

      // Any `roadmap_votes` row that lands for this idea AFTER the snapshot
      // above (a member voting in the split second between it and this
      // delete) is intentionally dropped here rather than migrated onto the
      // target — a vanishingly small window, not worth a re-query loop for
      // a feature-idea vote count. The idea row itself is already gone by
      // the time such a vote could even reference it via a real FK, so this
      // is strictly cleanup of the polymorphic `roadmap_votes` rows.
      await manager.delete(RoadmapVote, {
        targetType: RoadmapVoteTarget.Idea,
        targetId: id,
      });
      await manager.delete(RoadmapIdea, { id });

      await this.audit(
        actor,
        `Merged idea "${idea.text}" into "${savedTarget.name}"`,
        manager,
      );

      return { item: savedTarget, notifySubmitterId: idea.submittedById };
    });

    if (result.notifySubmitterId) {
      try {
        await this.notifications.create(
          result.notifySubmitterId,
          NotificationType.RoadmapStatus,
          { source: 'roadmap', itemId: result.item.id, status: 'merged' },
        );
      } catch {
        // Best-effort — the merge already committed.
      }
    }

    return toAdminItemDTO(result.item, await this.buildItemExtras(result.item));
  }

  // Marks a pending idea as not-building — `status: dismissed` + the
  // member-facing reason/note, which surface publicly on the "Not building
  // this, and why" section (see `RoadmapIdea.declineReason`'s doc). Reopening
  // later is a plain `updateIdea` `{ status: 'published' }` (which clears
  // these two fields, see that method's doc), not the inverse of this one.
  async declineIdea(
    id: string,
    dto: DeclineIdeaDto,
    actor?: RoadmapActor,
  ): Promise<AdminRoadmapIdeaDTO> {
    const idea = await this.loadIdeaOr404(id);
    idea.status = RoadmapIdeaStatus.Dismissed;
    idea.declineReason = dto.reason;
    idea.declineNote = dto.note;
    const saved = await this.ideas.save(idea);
    await this.audit(actor, `Declined idea "${saved.text}" (${dto.reason})`);

    if (saved.submittedById) {
      try {
        await this.notifications.create(
          saved.submittedById,
          NotificationType.RoadmapStatus,
          { source: 'roadmap', ideaId: saved.id, status: saved.status },
        );
      } catch {
        // Best-effort — the decline already committed.
      }
    }

    const liveVotes =
      (await this.liveVoteCounts(RoadmapVoteTarget.Idea, [id])).get(id) ?? 0;
    return toAdminIdeaDTO(saved, liveVotes);
  }

  // Upserts the `roadmap_settings` singleton (id = 1) — mirrors
  // `GovernanceOverview`/`ChangemakerDirectorySettings`'s "no authoring
  // endpoint beyond an admin edit" singleton pattern.
  async updateSettings(
    dto: UpdateSettingsDto,
    actor?: RoadmapActor,
  ): Promise<{ heroStats: HeroStat[] }> {
    let row = await this.settings.findOne({ where: { id: 1 } });
    if (!row) row = this.settings.create({ id: 1, heroStats: [] });
    row.heroStats = dto.heroStats;
    await this.settings.save(row);
    await this.audit(actor, 'Updated roadmap hero stats');
    return { heroStats: row.heroStats };
  }

  // --- Team CRUD (Capacity view roster) ------------------------------------
  //
  // Names are always resolved from `users`/`profiles` via `MemberLookup`,
  // never stored on the row — same posture as `ownerName` on items (see
  // `getAdmin()`'s doc). `listTeam()` batches the lookup across the whole
  // roster in one query; the single-row mutators below resolve just the one
  // name they need, since they already touched exactly one `userId`.

  // Ordered by `sortOrder ASC`, one batched `users` query for every name —
  // no N+1 regardless of roster size. `getAdmin()` does the equivalent
  // inline (it shares one batched name lookup across items' owners AND the
  // team roster in a single call), so this exists as its own entry point
  // for `GET /admin/team` without duplicating that combined query.
  async listTeam(): Promise<RoadmapTeamMemberDTO[]> {
    const teamRows = await this.team.find({ order: { sortOrder: 'ASC' } });
    const nameRefs = await new MemberLookup(this.profiles).byUserIds(
      teamRows.map((member) => member.userId),
    );
    return teamRows.map((member) =>
      toTeamMemberDTO(member, this.nameOf(nameRefs.get(member.userId)) ?? ''),
    );
  }

  async createTeamMember(
    dto: CreateTeamMemberDto,
    actor?: RoadmapActor,
  ): Promise<RoadmapTeamMemberDTO> {
    let member: RoadmapTeamMember;
    try {
      member = await this.team.save(this.team.create(dto));
    } catch (error) {
      // `userId` is UNIQUE (`UQ_roadmap_team_members_user_id`, migration
      // `AddRoadmapAdminModel`) — a member has at most one roster row.
      if (isUniqueViolation(error, 'UQ_roadmap_team_members_user_id')) {
        throw new ConflictException('This member is already on the team');
      }
      throw error;
    }
    const nameRefs = await new MemberLookup(this.profiles).byUserIds([
      member.userId,
    ]);
    const resolvedName = this.nameOf(nameRefs.get(member.userId));
    await this.audit(
      actor,
      `Added "${resolvedName ?? member.userId}" to the team as ${member.role}`,
    );
    return toTeamMemberDTO(member, resolvedName ?? '');
  }

  async updateTeamMember(
    id: string,
    dto: UpdateTeamMemberDto,
    actor?: RoadmapActor,
  ): Promise<RoadmapTeamMemberDTO> {
    const member = await this.loadTeamMemberOr404(id);
    Object.assign(member, dto);
    let saved: RoadmapTeamMember;
    try {
      saved = await this.team.save(member);
    } catch (error) {
      // Same unique guard as `createTeamMember` — `dto.userId` (optional on
      // update; see `UpdateTeamMemberDto`'s doc) can reassign this row to a
      // member who already has one.
      if (isUniqueViolation(error, 'UQ_roadmap_team_members_user_id')) {
        throw new ConflictException('This member is already on the team');
      }
      throw error;
    }
    const nameRefs = await new MemberLookup(this.profiles).byUserIds([
      saved.userId,
    ]);
    const resolvedName = this.nameOf(nameRefs.get(saved.userId));
    await this.audit(
      actor,
      `Updated team member "${resolvedName ?? saved.userId}"`,
    );
    return toTeamMemberDTO(saved, resolvedName ?? '');
  }

  async deleteTeamMember(id: string, actor?: RoadmapActor): Promise<void> {
    const member = await this.loadTeamMemberOr404(id);
    const nameRefs = await new MemberLookup(this.profiles).byUserIds([
      member.userId,
    ]);
    const name = this.nameOf(nameRefs.get(member.userId)) ?? member.userId;
    // Removing a roster row is scoped to `roadmap_team_members` only. Items
    // this person owns keep their `ownerId` (and so their `ownerName`) —
    // `roadmap_items.owner_id` is a separate FK straight to `users`
    // (`ON DELETE SET NULL`, migration `AddRoadmapAdminModel`), not to this
    // table, so leaving/being removed from the team roster does not touch
    // items they've shipped or are still building. That's intentional: the
    // roster is "who's actively staffed right now", not the historical
    // record of who built what.
    await this.team.delete({ id });
    await this.audit(actor, `Removed "${name}" from the team`);
  }

  // --- Audit trail read + CSV export ----------------------------------------

  // Newest-first, cursor-paginated by `createdAt` (not by id/offset): `before`
  // is an ISO timestamp and the query returns rows strictly older than it
  // (`createdAt < before`), which is the simplest cursor that stays correct
  // as new rows are appended between page fetches — an offset cursor would
  // skip/repeat rows once new audit entries land ahead of the page boundary.
  // The audit log is an append-only admin-monitoring feed, not a
  // strictly-ordered ledger a client reconciles line-by-line, so the
  // theoretical edge case of two rows sharing the exact same `createdAt`
  // (whole microseconds apart, `timestamptz`) landing on a page boundary is
  // an acceptable trade-off rather than one worth a compound (createdAt, id)
  // cursor. Uses the `IDX_roadmap_audit_log_created_at` index (migration
  // `AddRoadmapAdminModel`) for the sort.
  async getAudit(params: {
    limit?: number;
    before?: string;
  }): Promise<RoadmapAuditEntryDTO[]> {
    const limit = Math.min(Math.max(params.limit ?? 100, 1), 500);
    const rows = await this.auditLog.find({
      where: params.before
        ? { createdAt: LessThan(new Date(params.before)) }
        : {},
      order: { createdAt: 'DESC' },
      take: limit,
    });
    return rows.map(toAuditEntryDTO);
  }

  // Raw CSV string — the controller (Task A7) is responsible for the
  // `text/csv` content type + `Content-Disposition` response headers, this
  // just builds the body. Newest-first, capped at the last 5000 entries (a
  // download, not a paginated feed — 5000 rows is generous headroom over
  // what any admin session's audit trail will realistically reach, and
  // avoids an unbounded export as the log grows over the platform's
  // lifetime). Every field is formula-guarded (see `neutralizeCsvFormula`),
  // then quoted with embedded `"` doubled (`"` -> `""`), the standard CSV
  // escape — matches the prototype's `exportAudit` in `qp-roadmap-admin.js`.
  async getAuditCsv(): Promise<string> {
    const rows = await this.auditLog.find({
      order: { createdAt: 'DESC' },
      take: 5000,
    });
    const table = [
      ['when', 'who', 'what'],
      ...rows.map((row) => [
        row.createdAt.toISOString(),
        row.actorLabel,
        row.action,
      ]),
    ];
    return table
      .map((row) => row.map((field) => this.toCsvField(field)).join(','))
      .join('\n');
  }

  private toCsvField(value: string): string {
    const guarded = this.neutralizeCsvFormula(value);
    return `"${guarded.replace(/"/g, '""')}"`;
  }

  // Spreadsheet apps (Excel, Google Sheets, LibreOffice, Numbers) treat a
  // cell whose content starts with `=`, `+`, `-`, `@`, a tab, or a carriage
  // return as a formula to evaluate on open — an admin-facing CSV export can
  // carry attacker-controlled text (e.g. `actorLabel`), so a crafted display
  // name like `=cmd|'/c calc'!A1` would otherwise execute in the opening
  // app. Prefixing a `'` forces the cell to render as plain text; applied
  // before the RFC-4180 quote/escape above so the apostrophe lands inside
  // the quoted field rather than outside it.
  private neutralizeCsvFormula(value: string): string {
    return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  }

  private async loadTeamMemberOr404(id: string): Promise<RoadmapTeamMember> {
    const member = await this.team.findOne({ where: { id } });
    if (!member) throw new NotFoundException('Team member not found');
    return member;
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
