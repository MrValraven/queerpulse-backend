import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  CommunityResourceDTO,
  CommunityResourceShelfDTO,
  MAX_RESOURCES_PER_COMMUNITY,
  toCommunityResourceDTO,
} from './community-resources-response';
import {
  resolveMemberCommunity,
  resolveStaffCommunity,
} from './community-staff-access';
import {
  toStoredPlainText,
  toStoredPlainTextOrNull,
} from './community-plain-text';
import { CreateCommunityResourceDto } from './dto/create-community-resource.dto';
import { ReorderCommunityResourcesDto } from './dto/reorder-community-resources.dto';
import { UpdateCommunityResourceDto } from './dto/update-community-resource.dto';
import {
  CommunityMember,
  CommunityNotificationLevel,
} from './entities/community-member.entity';
import { CommunityResource } from './entities/community-resource.entity';
import { Community } from './entities/community.entity';

/**
 * Backs `/communities/:slug/resources` — the read and write side of a
 * community's resource shelf (`community_resources`).
 *
 * The About tab has rendered a resources shelf since the feature shipped, and
 * until now nothing could ever fill it: there was no entity, no endpoint and
 * no editor, so the shelf only ever showed demo fixtures. This service is what
 * makes it real.
 *
 * Its own file, with its own controller, rather than methods on
 * `CommunitiesService`/`CommunitiesController` — the convention this module
 * already follows for `CommunityPulseService` and `CommunityInsightsService`.
 * See `CommunityPulseController`'s doc comment for why a nested route path
 * does not require a nested controller.
 *
 * Authorization: reads are roster-member scoped and writes are staff scoped
 * (owner, co-owner, moderator), both through `community-staff-access.ts`. A
 * frozen community is deliberately NOT blocked here: a freeze halts new
 * activity from plain MEMBERS (`CommunityPostsService.assertNotFrozen` exempts
 * owner/mods so they can still post a note and moderate), and every write on
 * this shelf is already staff-only.
 */
@Injectable()
export class CommunityResourcesService {
  private readonly logger = new Logger(CommunityResourcesService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityResource)
    private readonly resources: Repository<CommunityResource>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * The whole shelf for one community, for any member of it. Ordered by
   * `position` ascending with `createdAt` as the tie-break, so two rows that
   * were never explicitly ordered still come back in a stable order rather
   * than whatever Postgres happens to return.
   */
  async listBySlug(
    slug: string,
    userId: string,
  ): Promise<CommunityResourceShelfDTO> {
    const { community } = await resolveMemberCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    const rows = await this.resources.find({
      where: { communityId: community.id },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    return {
      resources: await this.toDTOs(rows),
      maxResources: MAX_RESOURCES_PER_COMMUNITY,
    };
  }

  /**
   * Pin a new resource to the shelf (owner, co-owner or moderator).
   *
   * Appended to the END of the shelf (`position` one past the current
   * maximum), so adding never silently reshuffles an order the owner already
   * arranged. The entity's `position` default of 0 stays as the fallback for a
   * row written outside this path.
   */
  async create(
    slug: string,
    userId: string,
    dto: CreateCommunityResourceDto,
  ): Promise<CommunityResourceDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );

    const existingCount = await this.resources.count({
      where: { communityId: community.id },
    });
    if (existingCount >= MAX_RESOURCES_PER_COMMUNITY) {
      throw new ConflictException(
        `A community's resource shelf holds at most ${MAX_RESOURCES_PER_COMMUNITY} entries. Remove one before adding another.`,
      );
    }

    const title = toStoredPlainText(dto.title);
    if (!title) {
      throw new BadRequestException('A resource needs a title');
    }

    const saved = await this.resources.save(
      this.resources.create({
        communityId: community.id,
        title,
        url: dto.url.trim(),
        note: toStoredPlainTextOrNull(dto.note),
        kind: dto.kind,
        position: await this.nextPosition(community.id),
        createdByUserId: userId,
      }),
    );

    await this.notifyResourceAdded(community, userId, saved);

    const [dtoRow] = await this.toDTOs([saved]);
    // `toDTOs` returns one row per input row, so this is always defined. The
    // fallback keeps `strictNullChecks` satisfied without an assertion.
    return dtoRow ?? toCommunityResourceDTO(saved, null);
  }

  /** Edit one resource in place (owner, co-owner or moderator). */
  async update(
    slug: string,
    userId: string,
    resourceId: string,
    dto: UpdateCommunityResourceDto,
  ): Promise<CommunityResourceDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    const resource = await this.loadResourceOr404(community.id, resourceId);

    if (dto.title !== undefined) {
      const title = toStoredPlainText(dto.title);
      if (!title) {
        throw new BadRequestException('A resource needs a title');
      }
      resource.title = title;
    }
    if (dto.url !== undefined) {
      resource.url = dto.url.trim();
    }
    // Present-but-empty (`null` or `''`) clears the note; omitted leaves it.
    if (dto.note !== undefined) {
      resource.note = toStoredPlainTextOrNull(dto.note);
    }
    if (dto.kind !== undefined) {
      resource.kind = dto.kind;
    }

    const saved = await this.resources.save(resource);
    const [dtoRow] = await this.toDTOs([saved]);
    return dtoRow ?? toCommunityResourceDTO(saved, null);
  }

  /**
   * Take one resource off the shelf (owner, co-owner or moderator).
   *
   * The remaining rows keep their positions, gaps and all: `position` is only
   * ever read as a sort key, so a gap changes nothing a member can see, and
   * renumbering here would mean writing every row on every delete.
   */
  async remove(
    slug: string,
    userId: string,
    resourceId: string,
  ): Promise<{ ok: true }> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );
    const resource = await this.loadResourceOr404(community.id, resourceId);
    await this.resources.delete({ id: resource.id });
    return { ok: true };
  }

  /**
   * Set the shelf's order in one call (owner, co-owner or moderator).
   *
   * `resourceIds` must be exactly the shelf's current rows, each listed once:
   * a partial list would leave the rows it omits holding positions that
   * interleave with the new ones, which is how a "reorder" quietly produces an
   * order nobody chose. Rejecting the mismatch keeps the stored order equal to
   * what the owner was looking at, and tells a client working from a stale
   * shelf to refetch.
   *
   * Written in one transaction so a shelf can never be left half-renumbered.
   */
  async reorder(
    slug: string,
    userId: string,
    dto: ReorderCommunityResourcesDto,
  ): Promise<CommunityResourceShelfDTO> {
    const { community } = await resolveStaffCommunity(
      this.communities,
      this.members,
      slug,
      userId,
    );

    const current = await this.resources.find({
      where: { communityId: community.id },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const requested = dto.resourceIds;
    const requestedSet = new Set(requested);
    if (requestedSet.size !== requested.length) {
      throw new BadRequestException(
        'The same resource was listed more than once',
      );
    }
    if (
      requested.length !== current.length ||
      current.some((row) => !requestedSet.has(row.id))
    ) {
      throw new BadRequestException(
        "The order must list every resource on this community's shelf exactly once",
      );
    }

    const positionById = new Map(
      requested.map((resourceId, index) => [resourceId, index]),
    );
    await this.dataSource.transaction(async (manager) => {
      const repository = manager.getRepository(CommunityResource);
      for (const row of current) {
        const position = positionById.get(row.id);
        if (position === undefined || position === row.position) continue;
        await repository.update({ id: row.id }, { position });
      }
    });

    const reordered = await this.resources.find({
      where: { communityId: community.id },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    return {
      resources: await this.toDTOs(reordered),
      maxResources: MAX_RESOURCES_PER_COMMUNITY,
    };
  }

  private async loadResourceOr404(
    communityId: string,
    resourceId: string,
  ): Promise<CommunityResource> {
    const resource = await this.resources.findOne({
      where: { id: resourceId, communityId },
    });
    if (!resource) {
      throw new NotFoundException('Resource not found');
    }
    return resource;
  }

  /** One past the shelf's highest `position`, or 0 for an empty shelf. */
  private async nextPosition(communityId: string): Promise<number> {
    const last = await this.resources.findOne({
      where: { communityId },
      order: { position: 'DESC' },
    });
    return last ? last.position + 1 : 0;
  }

  /**
   * Hand-map rows to DTOs, resolving every `createdByUserId` in ONE batched
   * profile lookup (`MemberLookup.byUserIds`) rather than a query per row.
   */
  private async toDTOs(
    rows: CommunityResource[],
  ): Promise<CommunityResourceDTO[]> {
    if (!rows.length) return [];
    const authorIds = [
      ...new Set(
        rows
          .map((row) => row.createdByUserId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const refByUserId: Map<string, MemberRef> = authorIds.length
      ? await new MemberLookup(this.profiles).byUserIds(authorIds)
      : new Map<string, MemberRef>();
    return rows.map((row) =>
      toCommunityResourceDTO(
        row,
        row.createdByUserId
          ? (refByUserId.get(row.createdByUserId) ?? null)
          : null,
      ),
    );
  }

  /**
   * Best-effort "a resource was pinned" fan-out, in its own try/catch after
   * the row has already committed, so a notification failure can never fail
   * the write (the contract every notification path in this module follows,
   * see `CommunitiesService.notifyStaffOfJoinRequest`).
   *
   * Scoped to members whose `community_members.notification_level` is `all`,
   * excluding the owner/mod who added it. That per-member level IS the consent
   * here, which is what `NotificationType.CommunityResourceAdded`'s own
   * docstring specifies: a shelf addition is useful, and it is not the kind of
   * thing that should reach someone who turned this community down to
   * announcements only.
   */
  private async notifyResourceAdded(
    community: Community,
    actorUserId: string,
    resource: CommunityResource,
  ): Promise<void> {
    try {
      const recipients = await this.members.find({
        where: {
          communityId: community.id,
          notificationLevel: CommunityNotificationLevel.All,
        },
        select: { userId: true },
      });
      const recipientIds = recipients
        .map((row) => row.userId)
        .filter((recipientId) => recipientId !== actorUserId);
      if (!recipientIds.length) return;

      await this.notifications.createForRecipients(
        recipientIds,
        NotificationType.CommunityResourceAdded,
        {
          actorId: actorUserId,
          source: 'community',
          communitySlug: community.slug,
          communityName: community.name,
          title: resource.title,
        },
        actorUserId,
      );
    } catch (error) {
      this.logger.error(
        `Resource ${resource.id} was added to community ${community.id}, but notifying the roster failed: ${String(error)}`,
      );
    }
  }
}
