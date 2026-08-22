import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { Repository } from 'typeorm';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { assertNoForeignUploadIntroduced } from '../storage/assert-no-foreign-upload';
import { Changemaker, ChangemakerStatus } from './entities/changemaker.entity';
import {
  CHANGEMAKER_SETTINGS_ID,
  ChangemakerDirectorySettings,
} from './entities/changemaker-directory-settings.entity';
import {
  ChangemakerDTO,
  ChangemakerListResponseDTO,
  DirectoryStatsDTO,
  toChangemakerDTO,
} from './changemakers-response';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';
import { UpdateDirectoryStatsDto } from './dto/update-directory-stats.dto';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `PartnersService`'s/`ListingsService`'s identical file-local helper (not
// shared/exported, kept consistent with that precedent).
@Injectable()
export class ChangemakersService {
  constructor(
    @InjectRepository(Changemaker)
    private readonly changemakers: Repository<Changemaker>,
    @InjectRepository(ChangemakerDirectorySettings)
    private readonly settings: Repository<ChangemakerDirectorySettings>,
  ) {}

  async listPublic(): Promise<ChangemakerListResponseDTO> {
    // Bounded: this was an unbounded `find()` on a `@Public()`, CDN-cached
    // route, so the response size was whatever the directory had grown to.
    const published = await this.changemakers.find({
      where: { status: ChangemakerStatus.Published },
      order: { isFeatured: 'DESC', sortOrder: 'ASC', publishedAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    const settings = await this.loadSettings();
    return {
      profiles: published.map(toChangemakerDTO),
      // Counted in SQL over EVERY published profile, not over the page above:
      // the headline "N profiled / N cause areas" figures must not silently
      // stop counting once the directory outgrows one page.
      stats: {
        ...(await this.publishedTotals()),
        peopleHelped: settings.peopleHelped,
        activeCampaigns: settings.activeCampaigns,
      },
    };
  }

  /** `profiled` + `causeAreas` across every published profile. */
  private async publishedTotals(): Promise<{
    profiled: number;
    causeAreas: number;
  }> {
    const row = await this.changemakers
      .createQueryBuilder('c')
      .select('COUNT(*)', 'profiled')
      .addSelect('COUNT(DISTINCT LOWER(TRIM(c.cause)))', 'causeAreas')
      .where('c.status = :status', { status: ChangemakerStatus.Published })
      .getRawOne<{ profiled: string; causeAreas: string }>();
    return {
      profiled: Number(row?.profiled ?? 0),
      causeAreas: Number(row?.causeAreas ?? 0),
    };
  }

  async getPublicBySlug(slug: string): Promise<ChangemakerDTO> {
    const profile = await this.changemakers.findOne({
      where: { slug, status: ChangemakerStatus.Published },
    });
    if (!profile) {
      throw new NotFoundException('Changemaker not found');
    }
    return toChangemakerDTO(profile);
  }

  async listAdmin(): Promise<ChangemakerDTO[]> {
    const all = await this.changemakers.find({
      order: { isFeatured: 'DESC', sortOrder: 'ASC', createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return all.map(toChangemakerDTO);
  }

  async create(
    requesterUserId: string,
    dto: CreateChangemakerDto,
  ): Promise<ChangemakerDTO> {
    // No stored baseline on create, so any foreign image key is refused (see
    // `assertNoForeignUploadIntroduced`). The admin create form presigns its
    // own upload in the acting admin's session, so `owner === requester` and a
    // legitimate create passes; only a copied foreign key is blocked.
    assertNoForeignUploadIntroduced(requesterUserId, dto.imageUrl, []);
    const saved = await this.createWithUniqueSlug(dto);
    return toChangemakerDTO(saved);
  }

  async update(
    requesterUserId: string,
    id: string,
    dto: UpdateChangemakerDto,
  ): Promise<ChangemakerDTO> {
    const profile = await this.requireById(id);
    // Runs BEFORE mutating: any admin may re-save the image another admin
    // sourced, but may not point it at a NEW foreign key.
    assertNoForeignUploadIntroduced(requesterUserId, dto.imageUrl, [
      profile.imageUrl,
    ]);
    Object.assign(profile, dto);
    const saved = await this.changemakers.save(profile);
    return toChangemakerDTO(saved);
  }

  async remove(id: string): Promise<void> {
    const profile = await this.requireById(id);
    await this.changemakers.remove(profile);
  }

  async setPublished(id: string, published: boolean): Promise<ChangemakerDTO> {
    const profile = await this.requireById(id);
    profile.status = published
      ? ChangemakerStatus.Published
      : ChangemakerStatus.Draft;
    profile.publishedAt = published
      ? (profile.publishedAt ?? new Date())
      : null;
    const saved = await this.changemakers.save(profile);
    return toChangemakerDTO(saved);
  }

  async updateStats(dto: UpdateDirectoryStatsDto): Promise<DirectoryStatsDTO> {
    const settings = await this.loadSettings();
    settings.peopleHelped = dto.peopleHelped;
    settings.activeCampaigns = dto.activeCampaigns;
    await this.settings.save(settings);
    // Same SQL aggregate `listPublic` uses — this used to load every published
    // row just to count them.
    return {
      ...(await this.publishedTotals()),
      peopleHelped: settings.peopleHelped,
      activeCampaigns: settings.activeCampaigns,
    };
  }

  private async requireById(id: string): Promise<Changemaker> {
    const profile = await this.changemakers.findOne({ where: { id } });
    if (!profile) {
      throw new NotFoundException('Changemaker not found');
    }
    return profile;
  }

  private async loadSettings(): Promise<ChangemakerDirectorySettings> {
    const existing = await this.settings.findOne({
      where: { id: CHANGEMAKER_SETTINGS_ID },
    });
    if (existing) {
      return existing;
    }
    return this.settings.create({
      id: CHANGEMAKER_SETTINGS_ID,
      peopleHelped: 0,
      activeCampaigns: 0,
    });
  }

  // The slug pre-check (`allocateUniqueSlug`) can lose a race to a concurrent
  // submission landing between the read and this INSERT; the unique index on
  // `slug` is the real backstop and turns that race into a 23505, forcing a
  // retry with a freshly recomputed slug (mirrors
  // `ListingsService.createWithUniqueSlug`/`CompaniesService.createWithUniqueSlug`/
  // `PartnersService.createWithUniqueSlug`).
  private async createWithUniqueSlug(
    dto: CreateChangemakerDto,
  ): Promise<Changemaker> {
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(dto.name, 'changemaker'),
        (candidate) => this.changemakers.exists({ where: { slug: candidate } }),
      );

      try {
        return await this.changemakers.save(
          this.changemakers.create({
            ...dto,
            slug,
            imageUrl: dto.imageUrl ?? null,
            status: ChangemakerStatus.Draft,
            publishedAt: null,
          }),
        );
      } catch (err) {
        if (isUniqueViolation(err)) {
          if (attempt < MAX_ATTEMPTS) {
            // Lost the slug race — recompute and retry.
            continue;
          }
          throw new ConflictException(
            'Could not allocate a unique changemaker slug',
          );
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved changemaker or throws.
    throw new ConflictException('Could not allocate a unique changemaker slug');
  }
}
