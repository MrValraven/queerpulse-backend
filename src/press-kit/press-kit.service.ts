import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DataSource,
  EntityManager,
  EntityTarget,
  IsNull,
  LessThanOrEqual,
  ObjectLiteral,
  Repository,
} from 'typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { Event, EventStatus } from '../events/entities/event.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { UsersService } from '../users/users.service';
import { CreatePressContactDto } from './dto/create-press-contact.dto';
import { CreatePressCoverageDto } from './dto/create-press-coverage.dto';
import { ReorderPressKitDto } from './dto/reorder-press-kit.dto';
import { UpdatePressContactDto } from './dto/update-press-contact.dto';
import { UpdatePressCoverageDto } from './dto/update-press-coverage.dto';
import { PressContact } from './entities/press-contact.entity';
import { PressCoverage } from './entities/press-coverage.entity';
import {
  AdminPressContactDTO,
  AdminPressCoverageDTO,
  buildPressKitFacts,
  PressKitResponseDTO,
  toAdminPressContactDTO,
  toAdminPressCoverageDTO,
  toPressContactDTO,
  toPressCoverageDTO,
} from './press-kit-response';

/**
 * The year QueerPulse was founded, shown as the `founded` fact. A static
 * module constant, not a query — there is no per-row "founding" record to
 * derive it from, so this is the single honest source. Set to `null` to drop
 * the fact entirely (`buildPressKitFacts` omits a null-valued fact).
 */
const FOUNDING_YEAR: string | null = '2024';

/** The minimal shape the generic ordered-list helpers rely on: an id to match
 *  on and a position to rewrite. Both press-kit list entities satisfy it. */
type OrderedListRow = ObjectLiteral & { id: string; position: number };

/**
 * Service behind the public press kit and its admin CRUD. The public payload's
 * FACTS are derived from real DB counts on every read (never stored, never
 * fabricated); its LISTS (coverage, contacts) are admin-curated rows filtered
 * to `active` and ordered by `position`. The admin surface is full CRUD +
 * reorder over both lists, seeing active AND inactive rows.
 */
@Injectable()
export class PressKitService {
  constructor(
    @InjectRepository(PressCoverage)
    private readonly pressCoverage: Repository<PressCoverage>,
    @InjectRepository(PressContact)
    private readonly pressContacts: Repository<PressContact>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(SafeSpaceNomination)
    private readonly safeSpaceNominations: Repository<SafeSpaceNomination>,
    @InjectRepository(MagazineIssue)
    private readonly magazineIssues: Repository<MagazineIssue>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly usersService: UsersService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * The public press-kit payload. Computes every fact with ONE batched count
   * query per metric (never per row) alongside the two active-list reads, all
   * in a single `Promise.all`, then maps the rows to their public DTOs by
   * hand. Facts without an honest source are never included.
   */
  async getPressKit(): Promise<PressKitResponseDTO> {
    // A `date` column compares correctly against a `YYYY-MM-DD` string, so a
    // future-dated (scheduled) issue is excluded — "issues published so far",
    // mirroring the `published_at <= now` honesty gate `MagazineService` uses
    // for articles and decks.
    const todayIsoDate = new Date().toISOString().slice(0, 10);

    const [
      activeMembersCount,
      communitiesCount,
      gatheringsCount,
      safeSpacesCount,
      magazineIssuesCount,
      activeCoverageRows,
      activeContactRows,
    ] = await Promise.all([
      // Active community size (pending/suspended excluded).
      this.usersService.countActiveMembers(),
      // Public, non-archived communities — the ones a visitor can actually
      // see (same rule as landing eligibility).
      this.communities.count({
        where: { accessTier: AccessTier.Public, archivedAt: IsNull() },
      }),
      // Published gatherings only — drafts (not yet live) and cancelled ones
      // are not honest "gatherings held/scheduled".
      this.events.count({ where: { status: EventStatus.Published } }),
      // Only nominations a moderator has APPROVED count as real safe spaces;
      // pending/rejected are an intake queue, not a badge.
      this.safeSpaceNominations.count({ where: { status: 'approved' } }),
      // Issues published on or before today.
      this.magazineIssues.count({
        where: { publishedOn: LessThanOrEqual(todayIsoDate) },
      }),
      this.pressCoverage.find({
        where: { active: true },
        order: { position: 'ASC' },
      }),
      this.pressContacts.find({
        where: { active: true },
        order: { position: 'ASC' },
      }),
    ]);

    const facts = buildPressKitFacts({
      foundedYear: FOUNDING_YEAR,
      activeMembers: activeMembersCount,
      communities: communitiesCount,
      gatherings: gatheringsCount,
      safeSpaces: safeSpacesCount,
      magazineIssues: magazineIssuesCount,
    });

    return {
      facts,
      coverage: activeCoverageRows.map(toPressCoverageDTO),
      contacts: activeContactRows.map(toPressContactDTO),
    };
  }

  // ---- Admin: press coverage ----------------------------------------------

  async listAdminCoverage(): Promise<AdminPressCoverageDTO[]> {
    const rows = await this.pressCoverage.find({ order: { position: 'ASC' } });
    return rows.map(toAdminPressCoverageDTO);
  }

  async createCoverage(
    adminUserId: string,
    dto: CreatePressCoverageDto,
  ): Promise<AdminPressCoverageDTO> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const position = await this.computeNextPosition(manager, PressCoverage);
      const row = manager.create(PressCoverage, {
        source: dto.source,
        title: dto.title,
        meta: dto.meta,
        publishedOn: dto.publishedOn,
        url: dto.url ?? null,
        position,
        active: dto.active ?? true,
        createdBy: adminUserId,
      });
      return manager.save(row);
    });
    return toAdminPressCoverageDTO(saved);
  }

  async updateCoverage(
    id: string,
    dto: UpdatePressCoverageDto,
  ): Promise<AdminPressCoverageDTO> {
    const row = await this.pressCoverage.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Press coverage not found.');
    }
    if (dto.source !== undefined) row.source = dto.source;
    if (dto.title !== undefined) row.title = dto.title;
    if (dto.meta !== undefined) row.meta = dto.meta;
    if (dto.publishedOn !== undefined) row.publishedOn = dto.publishedOn;
    if (dto.url !== undefined) row.url = dto.url;
    if (dto.active !== undefined) row.active = dto.active;
    const saved = await this.pressCoverage.save(row);
    return toAdminPressCoverageDTO(saved);
  }

  async reorderCoverage(
    dto: ReorderPressKitDto,
  ): Promise<AdminPressCoverageDTO[]> {
    await this.reorderList(PressCoverage, dto.orderedIds);
    return this.listAdminCoverage();
  }

  async deleteCoverage(id: string): Promise<void> {
    const result = await this.pressCoverage.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Press coverage not found.');
    }
  }

  // ---- Admin: press contacts ----------------------------------------------

  async listAdminContacts(): Promise<AdminPressContactDTO[]> {
    const rows = await this.pressContacts.find({ order: { position: 'ASC' } });
    return rows.map(toAdminPressContactDTO);
  }

  async createContact(
    adminUserId: string,
    dto: CreatePressContactDto,
  ): Promise<AdminPressContactDTO> {
    const saved = await this.dataSource.transaction(async (manager) => {
      const position = await this.computeNextPosition(manager, PressContact);
      const row = manager.create(PressContact, {
        name: dto.name,
        role: dto.role,
        description: dto.description,
        languages: dto.languages,
        email: dto.email,
        avatarUrl: dto.avatarUrl ?? null,
        position,
        active: dto.active ?? true,
        createdBy: adminUserId,
      });
      return manager.save(row);
    });
    return toAdminPressContactDTO(saved);
  }

  async updateContact(
    id: string,
    dto: UpdatePressContactDto,
  ): Promise<AdminPressContactDTO> {
    const row = await this.pressContacts.findOne({ where: { id } });
    if (!row) {
      throw new NotFoundException('Press contact not found.');
    }
    if (dto.name !== undefined) row.name = dto.name;
    if (dto.role !== undefined) row.role = dto.role;
    if (dto.description !== undefined) row.description = dto.description;
    if (dto.languages !== undefined) row.languages = dto.languages;
    if (dto.email !== undefined) row.email = dto.email;
    if (dto.avatarUrl !== undefined) row.avatarUrl = dto.avatarUrl;
    if (dto.active !== undefined) row.active = dto.active;
    const saved = await this.pressContacts.save(row);
    return toAdminPressContactDTO(saved);
  }

  async reorderContacts(
    dto: ReorderPressKitDto,
  ): Promise<AdminPressContactDTO[]> {
    await this.reorderList(PressContact, dto.orderedIds);
    return this.listAdminContacts();
  }

  async deleteContact(id: string): Promise<void> {
    const result = await this.pressContacts.delete({ id });
    if (!result.affected) {
      throw new NotFoundException('Press contact not found.');
    }
  }

  // ---- Shared ordered-list helpers ----------------------------------------

  /**
   * Next `position` for an append: locks the table's existing rows first, then
   * reads `MAX(position)`, so two concurrent creates can't read the same max
   * and collide. (A brand-new, empty table has nothing to lock — a narrower
   * first-two-rows race than the one this closes; positions are re-normalised
   * by the next reorder anyway.) Mirrors `LandingService.createFeature`.
   */
  private async computeNextPosition<Entity extends ObjectLiteral>(
    manager: EntityManager,
    entityClass: EntityTarget<Entity>,
  ): Promise<number> {
    await manager
      .createQueryBuilder(entityClass, 'row')
      .setLock('pessimistic_write')
      .getMany();
    const maxRow = await manager
      .createQueryBuilder(entityClass, 'row')
      .select('MAX(row.position)', 'maxPosition')
      .getRawOne<{ maxPosition: string | null }>();
    return maxRow?.maxPosition != null ? Number(maxRow.maxPosition) + 1 : 0;
  }

  /**
   * Rewrites every row's `position` to its index within `orderedIds`, inside
   * one transaction under a table lock. `orderedIds` must be EXACTLY the
   * current set of ids — anything missing or extra is rejected up front rather
   * than silently dropping or ignoring a row. The lock + validate + rewrite
   * all happen inside the transaction, so a concurrent create/delete can't
   * open a TOCTOU window. Mirrors `LandingService.reorderFeatures`.
   */
  private async reorderList<Entity extends OrderedListRow>(
    entityClass: EntityTarget<Entity>,
    orderedIds: string[],
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const existingRows = await manager
        .createQueryBuilder(entityClass, 'row')
        .setLock('pessimistic_write')
        .getMany();
      const existingRowsById = new Map(
        existingRows.map((row) => [row.id, row]),
      );
      const orderedIdsSet = new Set(orderedIds);
      const isExactSameSet =
        orderedIds.length === existingRows.length &&
        orderedIds.every((id) => existingRowsById.has(id)) &&
        existingRows.every((row) => orderedIdsSet.has(row.id));
      if (!isExactSameSet) {
        throw new BadRequestException(
          'orderedIds must be exactly the current ids for this list.',
        );
      }

      const reorderedRows: Entity[] = [];
      for (const [index, id] of orderedIds.entries()) {
        const row = existingRowsById.get(id);
        // Unreachable given the exact-set check above, but keeps the type
        // honest without a non-null assertion.
        if (!row) continue;
        row.position = index;
        reorderedRows.push(row);
      }
      await manager.save(reorderedRows);
    });
  }
}
