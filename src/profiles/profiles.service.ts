import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ConnectionsService } from '../connections/connections.service';
import { Profile, ProfileVisibility } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { VouchService } from '../vouch/vouch.service';
import { ListMembersQuery } from './dto/list-members.query';
import { SocialLinkDto } from './dto/replace-socials.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { WorkItemDto } from './dto/replace-work.dto';
import { SocialLink } from './entities/social-link.entity';
import { WorkItem } from './entities/work-item.entity';
import {
  FullProfileResponse,
  LimitedProfileResponse,
  MemberCard,
  SocialLinkView,
  WorkItemView,
  toFullProfile,
  toLimitedProfile,
  toMemberCard,
} from './profile-response';

const PAGE_SIZE = 20;

@Injectable()
export class ProfilesService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(SocialLink)
    private readonly socialLinks: Repository<SocialLink>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
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
    const [socials, work] = await Promise.all([
      this.socialLinks.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
      this.workItems.find({
        where: { userId: profile.userId },
        order: { position: 'ASC' },
      }),
    ]);
    return toFullProfile(profile, socials, work, vouchCount);
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
    const [socials, work, vouchCount] = await Promise.all([
      this.socialLinks.find({ where: { userId }, order: { position: 'ASC' } }),
      this.workItems.find({ where: { userId }, order: { position: 'ASC' } }),
      this.vouchService.getVouchCount(userId),
    ]);
    return toFullProfile(profile, socials, work, vouchCount);
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

  async replaceWork(
    userId: string,
    items: WorkItemDto[],
  ): Promise<WorkItemView[]> {
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
      ? q.tags.split(',').map((t) => t.trim()).filter(Boolean)
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
