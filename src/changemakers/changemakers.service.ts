import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
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
  toDirectoryStatsDTO,
} from './changemakers-response';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';
import { UpdateDirectoryStatsDto } from './dto/update-directory-stats.dto';

// Postgres unique-violation SQLSTATE. Mirrors `CompaniesService`'s/
// `PartnersService`'s/`ListingsService`'s identical file-local helper (not
// shared/exported, kept consistent with that precedent).
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; driverError?: { code?: string } };
  return e?.code === '23505' || e?.driverError?.code === '23505';
}

@Injectable()
export class ChangemakersService {
  constructor(
    @InjectRepository(Changemaker)
    private readonly changemakers: Repository<Changemaker>,
    @InjectRepository(ChangemakerDirectorySettings)
    private readonly settings: Repository<ChangemakerDirectorySettings>,
  ) {}

  async listPublic(): Promise<ChangemakerListResponseDTO> {
    const published = await this.changemakers.find({
      where: { status: ChangemakerStatus.Published },
      order: { isFeatured: 'DESC', sortOrder: 'ASC', publishedAt: 'DESC' },
    });
    const settings = await this.loadSettings();
    return {
      profiles: published.map(toChangemakerDTO),
      stats: toDirectoryStatsDTO(
        published,
        settings.peopleHelped,
        settings.activeCampaigns,
      ),
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
    });
    return all.map(toChangemakerDTO);
  }

  async create(dto: CreateChangemakerDto): Promise<ChangemakerDTO> {
    const saved = await this.createWithUniqueSlug(dto);
    return toChangemakerDTO(saved);
  }

  async update(id: string, dto: UpdateChangemakerDto): Promise<ChangemakerDTO> {
    const profile = await this.requireById(id);
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
    const published = await this.changemakers.find({
      where: { status: ChangemakerStatus.Published },
    });
    return toDirectoryStatsDTO(
      published,
      settings.peopleHelped,
      settings.activeCampaigns,
    );
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
