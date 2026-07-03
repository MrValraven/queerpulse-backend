import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import { ListMembersQuery } from './dto/list-members.query';
import { SocialLinkDto } from './dto/replace-socials.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { WorkItemDto } from './dto/replace-work.dto';
import { Activity } from './entities/activity.entity';
import { BoardPost } from './entities/board-post.entity';
import { Group } from './entities/group.entity';
import { GroupMembership } from './entities/group-membership.entity';
import { Shaping } from './entities/shaping.entity';
import { Skill } from './entities/skill.entity';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  FullProfileResponse,
  GroupView,
  LimitedProfileResponse,
  MemberCard,
  ProfileCard,
  ProfileRelations,
  SocialLinkView,
  WorkView,
  sortShapings,
  toFullProfile,
  toLimitedProfile,
  toMemberCard,
  toProfileCard,
} from './profile-response';

const PAGE_SIZE = 20;
const RELATED_LIMIT = 4;
const ACTIVITY_LIMIT = 6;

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(BoardPost)
    private readonly boardPosts: Repository<BoardPost>,
    @InjectRepository(Shaping) private readonly shapings: Repository<Shaping>,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
    @InjectRepository(Group) private readonly groups: Repository<Group>,
    @InjectRepository(GroupMembership)
    private readonly groupMemberships: Repository<GroupMembership>,
    private readonly dataSource: DataSource,
    private readonly vouchService: VouchService,
    private readonly connectionsService: ConnectionsService,
  ) {}

  async getBySlug(
    slug: string,
    viewerUserId: string,
  ): Promise<FullProfileResponse | LimitedProfileResponse> {
    const profile = await this.profiles.findOne({ where: { slug } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    const vouchCount = await this.vouchService.getVouchCount(profile.userId);
    if (!(await this.canViewFull(profile, viewerUserId))) {
      return toLimitedProfile(profile, vouchCount);
    }
    return this.buildFullProfile(profile, vouchCount);
  }

  private async buildFullProfile(
    profile: Profile,
    vouchCount: number,
  ): Promise<FullProfileResponse> {
    const userId = profile.userId;
    const [socials, work, board, skills, shapings, activity, groups, related] =
      await Promise.all([
        this.socialLinks.find({
          where: { userId },
          order: { position: 'ASC' },
        }),
        this.workItems.find({ where: { userId }, order: { position: 'ASC' } }),
        this.boardPosts.find({ where: { userId }, order: { position: 'ASC' } }),
        this.skills.find({ where: { userId }, order: { position: 'ASC' } }),
        this.shapings.find({ where: { userId } }),
        this.activities.find({
          where: { userId },
          order: { occurredAt: 'DESC' },
          take: ACTIVITY_LIMIT,
        }),
        this.loadGroups(userId),
        this.loadRelated(profile),
      ]);
    const rels: ProfileRelations = {
      socials,
      work,
      board,
      skills,
      groups,
      shapings,
      activity,
      related,
    };
    return toFullProfile(profile, rels, vouchCount);
  }

  private async loadGroups(userId: string): Promise<GroupView[]> {
    const rows = await this.groupMemberships
      .createQueryBuilder('gm')
      .innerJoin(Group, 'g', 'g.id = gm.group_id')
      .select('g.name', 'name')
      .addSelect('gm.role', 'role')
      .where('gm.user_id = :userId', { userId })
      .orderBy('g.name', 'ASC')
      .getRawMany<{ name: string; role: string }>();
    return rows.map((r) => ({ name: r.name, role: r.role }));
  }

  private async loadRelated(profile: Profile): Promise<ProfileCard[]> {
    const hasTags = profile.tags.length > 0;
    const hasLocation = !!profile.location;
    if (!hasTags && !hasLocation) {
      return [];
    }
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      })
      .where('p.user_id != :self', { self: profile.userId });
    const conds: string[] = [];
    const params: Record<string, unknown> = {};
    if (hasTags) {
      conds.push('p.tags && :tags');
      params.tags = profile.tags;
    }
    if (hasLocation) {
      conds.push('p.location = :loc');
      params.loc = profile.location;
    }
    qb.andWhere(`(${conds.join(' OR ')})`, params)
      .orderBy('p.first_name', 'ASC')
      .take(RELATED_LIMIT);
    const rows = await qb.getMany();
    const counts = await this.vouchService.getVouchCounts(
      rows.map((r) => r.userId),
    );
    return rows.map((r) => toProfileCard(r, counts.get(r.userId) ?? 0));
  }

  private async canViewFull(
    profile: Profile,
    viewerUserId: string,
  ): Promise<boolean> {
    if (profile.userId === viewerUserId) {
      return true; // owner
    }
    if (profile.visibility === ProfileVisibility.Open) {
      return true;
    }
    if (profile.visibility === ProfileVisibility.Network) {
      // network: accepted connections see the full profile.
      return this.connectionsService.areConnected(viewerUserId, profile.userId);
    }
    return false; // private → limited card to everyone but the owner
  }

  async updateMe(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<FullProfileResponse> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    Object.assign(profile, dto);
    await this.profiles.save(profile);
    const vouchCount = await this.vouchService.getVouchCount(userId);
    return this.buildFullProfile(profile, vouchCount);
  }

  async replaceSocials(
    userId: string,
    items: SocialLinkDto[],
  ): Promise<SocialLinkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SocialLink, { userId });
      const rows = items.map((it, index) =>
        manager.create(SocialLink, {
          userId,
          platform: it.platform,
          urlOrHandle: it.urlOrHandle,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.socialLinks.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({
      platform: s.platform,
      urlOrHandle: s.urlOrHandle,
      position: s.position,
    }));
  }

  async replaceWork(userId: string, items: WorkItemDto[]): Promise<WorkView[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(WorkItem, { userId });
      const rows = items.map((it, index) =>
        manager.create(WorkItem, {
          userId,
          category: it.category,
          title: it.title,
          year: it.year,
          imageUrl: it.imageUrl ?? null,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.workItems.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((w) => ({
      category: w.category,
      title: w.title,
      year: w.year,
      imageUrl: w.imageUrl,
      position: w.position,
    }));
  }

  async replaceSkills(
    userId: string,
    items: { name: string; meta: string }[],
  ): Promise<{ name: string; meta: string }[]> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Skill, { userId });
      const rows = items.map((it, index) =>
        manager.create(Skill, {
          userId,
          name: it.name,
          meta: it.meta,
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.skills.find({
      where: { userId },
      order: { position: 'ASC' },
    });
    return saved.map((s) => ({ name: s.name, meta: s.meta }));
  }

  async replaceShapings(
    userId: string,
    items: { kind: Shaping['kind']; title: string; note: string }[],
  ): Promise<{ kind: string; title: string; note: string }[]> {
    const seen = new Set<string>();
    for (const it of items) {
      if (seen.has(it.kind)) {
        throw new BadRequestException(`Duplicate shaping kind: ${it.kind}`);
      }
      seen.add(it.kind);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(Shaping, { userId });
      const rows = items.map((it) =>
        manager.create(Shaping, {
          userId,
          kind: it.kind,
          title: it.title,
          note: it.note,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    const saved = await this.shapings.find({ where: { userId } });
    return sortShapings(saved).map((s) => ({
      kind: s.kind,
      title: s.title,
      note: s.note,
    }));
  }

  async replaceGroups(
    userId: string,
    items: { groupSlug: string; role: string }[],
  ): Promise<GroupView[]> {
    const slugs = items.map((i) => i.groupSlug);
    const found = slugs.length
      ? await this.groups.find({ where: { slug: In(slugs) } })
      : [];
    const bySlug = new Map(found.map((g) => [g.slug, g]));
    for (const it of items) {
      if (!bySlug.has(it.groupSlug)) {
        throw new BadRequestException(`Unknown group: ${it.groupSlug}`);
      }
    }
    const seenSlugs = new Set<string>();
    for (const it of items) {
      if (seenSlugs.has(it.groupSlug)) {
        throw new BadRequestException(`Duplicate group: ${it.groupSlug}`);
      }
      seenSlugs.add(it.groupSlug);
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(GroupMembership, { userId });
      const rows = items.map((it) =>
        manager.create(GroupMembership, {
          userId,
          groupId: bySlug.get(it.groupSlug)!.id,
          role: it.role,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });
    return this.loadGroups(userId);
  }

  async searchMembers(q: ListMembersQuery): Promise<{
    items: MemberCard[];
    total: number;
    page: number;
    pageSize: number;
  }> {
    const page = q.page && q.page > 0 ? q.page : 1;
    const qb = this.profiles
      .createQueryBuilder('p')
      .innerJoin('p.user', 'u', 'u.status = :active', {
        active: UserStatus.Active,
      });

    if (q.query) {
      qb.andWhere(
        '(p.firstName ILIKE :term OR p.lastName ILIKE :term OR p.slug ILIKE :term OR p.tagline ILIKE :term)',
        { term: `%${q.query}%` },
      );
    }

    const tags = q.tags
      ? q.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [];
    if (tags.length) {
      qb.andWhere('p.tags && :tags', { tags });
    }

    qb.orderBy('p.firstName', 'ASC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    const [rows, total] = await qb.getManyAndCount();
    const counts = await this.vouchService.getVouchCounts(
      rows.map((r) => r.userId),
    );
    return {
      items: rows.map((r) => toMemberCard(r, counts.get(r.userId) ?? 0)),
      total,
      page,
      pageSize: PAGE_SIZE,
    };
  }
}
