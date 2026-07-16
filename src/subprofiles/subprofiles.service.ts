import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { HandlesService } from '../handles/handles.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { CreateSubprofileDTO } from './dto/create-subprofile.dto';
import { ListDirectoryQuery } from './dto/list-directory.query';
import { SubprofileItemInputDTO } from './dto/replace-items.dto';
import { UpdateSubprofileDTO } from './dto/update-subprofile.dto';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import {
  SubprofileItem,
  SubprofileSection,
} from './entities/subprofile-item.entity';
import type {
  SubprofileKind as SubprofileKindKey,
  SubprofileSection as SubprofileSectionKey,
} from './subprofile-kinds';
import { isSectionAllowed } from './subprofile-kinds';
import {
  MAX_ITEMS_PER_SECTION,
  MAX_SUBPROFILES,
  slugifyDisplayName,
  validatePublish,
} from './subprofile-validation';
import {
  SubprofileCardView,
  SubprofilePublicView,
  SubprofileView,
  toCardDTO,
  toPublicDTO,
  toSubprofileDTO,
} from './subprofile-response';

// Postgres unique-violation SQLSTATE (a duplicate handle races past the
// partial unique index `UQ_subprofiles_handle`).
const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}

@Injectable()
export class SubprofilesService {
  constructor(
    @InjectRepository(Subprofile)
    private readonly subprofiles: Repository<Subprofile>,
    @InjectRepository(SubprofileItem)
    private readonly items: Repository<SubprofileItem>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly handles: HandlesService,
  ) {}

  // ---- owner reads ---------------------------------------------------------

  async listMine(userId: string): Promise<SubprofileView[]> {
    const sps = await this.subprofiles.find({
      where: { userId },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const byId = await this.loadItemsFor(sps.map((s) => s.id));
    return sps.map((sp) => toSubprofileDTO(sp, byId.get(sp.id) ?? []));
  }

  async getOwned(userId: string, id: string): Promise<Subprofile> {
    const sp = await this.subprofiles.findOne({ where: { id } });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    if (sp.userId !== userId) {
      throw new ForbiddenException('Not your subprofile');
    }
    return sp;
  }

  async getOwnedDTO(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    return this.ownerDTO(sp);
  }

  // ---- owner mutations -----------------------------------------------------

  async create(
    userId: string,
    dto: CreateSubprofileDTO,
  ): Promise<SubprofileView> {
    const count = await this.subprofiles.count({ where: { userId } });
    if (count >= MAX_SUBPROFILES) {
      throw new BadRequestException(
        `You can have at most ${MAX_SUBPROFILES} subprofiles`,
      );
    }
    const slug = await this.generateSlug(userId, dto.displayName);
    const sp = this.subprofiles.create({
      userId,
      kind: dto.kind,
      displayName: dto.displayName,
      slug,
    });
    await this.saveSubprofile(sp);
    return toSubprofileDTO(sp, []);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateSubprofileDTO,
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const prevLink = sp.linkVisibility;
    const prevHandle = sp.handle;
    // A registry row exists for this persona IFF it is published + unlinked (see
    // the invariant documented on `publish`), and its name equals `prevHandle`.
    const wasPublishedUnlinked =
      sp.status === SubprofileStatus.Published &&
      prevLink === SubprofileLinkVisibility.Unlinked;
    const { linkVisibility, ...rest } = dto;
    Object.assign(sp, rest);

    // Global-namespace names to free as a side effect of this update.
    const releases: string[] = [];

    if (linkVisibility && linkVisibility !== prevLink) {
      sp.linkVisibility = linkVisibility;
      if (linkVisibility === SubprofileLinkVisibility.Linked) {
        // unlinked → linked: it becomes nested and drops its global handle. If
        // it was a published unlinked persona, free the name it held.
        if (wasPublishedUnlinked && prevHandle) {
          releases.push(prevHandle);
        }
        sp.handle = null;
      } else {
        // linked → unlinked: must re-pass the completeness check before it can
        // (re)publish and claim a handle — leave it unpublished until then.
        sp.status = SubprofileStatus.Draft;
      }
    } else if (
      wasPublishedUnlinked &&
      prevHandle &&
      sp.handle !== prevHandle
    ) {
      // RULE (chosen): changing the `handle` of an already-published, UNLINKED
      // persona invalidates its live listing. Mirroring the existing
      // "must re-validate" rule, we revert it to DRAFT and RELEASE the old
      // registry name now; the claim happens (under the new name) on the next
      // publish, never here. No release/reclaim churn while it stays a draft.
      sp.status = SubprofileStatus.Draft;
      releases.push(prevHandle);
    }

    if (releases.length) {
      try {
        await this.dataSource.transaction(async (m) => {
          for (const name of releases) {
            await this.handles.release(m, name);
          }
          await m.save(sp);
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new ConflictException('slug or handle already in use');
        }
        throw err;
      }
    } else {
      await this.saveSubprofile(sp);
    }
    return this.ownerDTO(sp);
  }

  async replaceSection(
    userId: string,
    id: string,
    section: string,
    items: SubprofileItemInputDTO[],
  ): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);

    if (!Object.values(SubprofileSection).includes(section as SubprofileSection)) {
      throw new BadRequestException(`Unknown section: ${section}`);
    }
    const sectionEnum = section as SubprofileSection;
    if (
      !isSectionAllowed(
        sp.kind as unknown as SubprofileKindKey,
        sectionEnum as unknown as SubprofileSectionKey,
      )
    ) {
      throw new BadRequestException(
        `Section "${section}" is not valid for kind "${sp.kind}"`,
      );
    }
    if (items.length > MAX_ITEMS_PER_SECTION) {
      throw new BadRequestException(
        `A section can have at most ${MAX_ITEMS_PER_SECTION} items`,
      );
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.delete(SubprofileItem, {
        subprofileId: id,
        section: sectionEnum,
      });
      const rows = items.map((it, index) =>
        manager.create(SubprofileItem, {
          subprofileId: id,
          section: sectionEnum,
          title: it.title,
          subtitle: it.subtitle ?? null,
          description: it.description ?? null,
          url: it.url ?? null,
          imageUrl: it.imageUrl ?? null,
          date: it.date ?? null,
          meta: it.meta ?? null,
          tags: it.tags ?? [],
          position: index,
        }),
      );
      if (rows.length) {
        await manager.save(rows);
      }
    });

    return this.ownerDTO(sp);
  }

  async publish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    const items = await this.items.find({ where: { subprofileId: id } });

    const unlinked = sp.linkVisibility === SubprofileLinkVisibility.Unlinked;

    // `handle_taken` now reflects the WHOLE global namespace (main usernames +
    // every other subprofile handle), not just other subprofiles. Excluding
    // this persona's own owner lets a re-publish of the same name pass.
    let handleTaken = false;
    if (unlinked && sp.handle) {
      handleTaken = await this.handles.isTaken(this.dataSource.manager, sp.handle, {
        kind: 'subprofile',
        subprofileId: sp.id,
      });
    }

    const unmet = validatePublish(sp, items, handleTaken);
    if (unmet.length) {
      throw new UnprocessableEntityException({ unmet });
    }

    if (!unlinked) {
      // Linked personas render nested and never carry a global handle.
      sp.handle = null;
      sp.status = SubprofileStatus.Published;
      await this.saveSubprofile(sp);
      return toSubprofileDTO(sp, items);
    }

    // Unlinked: claim the validated handle in the global registry AND flip to
    // published in ONE transaction, so a lost race on the name fails atomically
    // (the row stays a draft). INVARIANT: a registry row exists for a persona
    // IFF it is currently published + unlinked, and that row's name equals its
    // `handle`. So an already-published re-publish renames `handle → handle`
    // (a no-op that keeps the existing claim); a draft renames `null → handle`
    // (a fresh claim).
    const existingClaimedName =
      sp.status === SubprofileStatus.Published ? sp.handle : null;
    try {
      await this.dataSource.transaction(async (m) => {
        await this.handles.rename(m, existingClaimedName, sp.handle!, {
          kind: 'subprofile',
          subprofileId: sp.id,
        });
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Published },
        );
      });
    } catch (err) {
      // Someone claimed the name between the pre-check and the write. Surface as
      // 422 `handle_taken` to stay consistent with the publish completeness
      // contract (rather than leaking a bare 409).
      if (err instanceof ConflictException) {
        throw new UnprocessableEntityException({ unmet: ['handle_taken'] });
      }
      throw err;
    }
    sp.status = SubprofileStatus.Published;
    return toSubprofileDTO(sp, items);
  }

  async unpublish(userId: string, id: string): Promise<SubprofileView> {
    const sp = await this.getOwned(userId, id);
    if (
      sp.linkVisibility === SubprofileLinkVisibility.Unlinked &&
      sp.handle
    ) {
      // Free the global name AND null the handle + draft the status in ONE
      // transaction, so the registry and the row can never disagree.
      const handle = sp.handle;
      await this.dataSource.transaction(async (m) => {
        await this.handles.release(m, handle);
        await m.update(
          Subprofile,
          { id: sp.id },
          { status: SubprofileStatus.Draft, handle: null },
        );
      });
      sp.status = SubprofileStatus.Draft;
      sp.handle = null;
    } else {
      sp.status = SubprofileStatus.Draft;
      await this.saveSubprofile(sp);
    }
    return this.ownerDTO(sp);
  }

  async remove(userId: string, id: string): Promise<void> {
    const sp = await this.getOwned(userId, id);
    // `subprofile_items` AND the persona's `handles` registry row (if any) both
    // cascade via their FK's ON DELETE CASCADE on `subprofile_id` — deleting the
    // subprofile auto-frees its global handle, so no explicit release is needed.
    await this.subprofiles.remove(sp);
  }

  // ---- public reads --------------------------------------------------------

  // Linked + published personas nested under a member's main profile.
  async listForProfile(
    ownerSlug: string,
    viewerId: string,
  ): Promise<SubprofilePublicView[]> {
    const profile = await this.profiles.findOne({
      where: { slug: ownerSlug },
    });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    // A block either way severs the nested-persona listing.
    if (await this.blockFilter.isBlockedEitherWay(viewerId, profile.userId)) {
      return [];
    }
    const sps = await this.subprofiles.find({
      where: {
        userId: profile.userId,
        linkVisibility: SubprofileLinkVisibility.Linked,
        status: SubprofileStatus.Published,
      },
      order: { position: 'ASC', createdAt: 'ASC' },
    });
    const byId = await this.loadItemsFor(sps.map((s) => s.id));
    const owner = {
      slug: profile.slug,
      name: `${profile.firstName} ${profile.lastName}`.trim(),
    };
    return sps.map((sp) =>
      toPublicDTO(sp, byId.get(sp.id) ?? [], owner),
    );
  }

  // Unlinked + published persona reachable by its global handle. Owner-stripped.
  async getByHandle(
    handle: string,
    viewerId: string,
  ): Promise<SubprofilePublicView> {
    const sp = await this.subprofiles.findOne({
      where: {
        handle,
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Published,
      },
    });
    if (!sp) {
      throw new NotFoundException('Subprofile not found');
    }
    // Never surface the persona of someone the viewer has blocked (either way).
    if (await this.blockFilter.isBlockedEitherWay(viewerId, sp.userId)) {
      throw new NotFoundException('Subprofile not found');
    }
    const items = await this.items.find({ where: { subprofileId: sp.id } });
    return toPublicDTO(sp, items); // no owner → owner fields omitted
  }

  // Directory of standalone (unlinked + published + open) personas.
  async directory(
    query: ListDirectoryQuery,
    viewerId: string,
  ): Promise<{ items: SubprofileCardView[] }> {
    const qb = this.subprofiles
      .createQueryBuilder('sp')
      .where('sp.linkVisibility = :linked', {
        linked: SubprofileLinkVisibility.Unlinked,
      })
      .andWhere('sp.status = :published', {
        published: SubprofileStatus.Published,
      })
      .andWhere('sp.visibility = :open', {
        open: SubprofileVisibility.Open,
      })
      .andWhere('sp.handle IS NOT NULL');

    // Hide personas of members blocked either way (design spec §4). The raw
    // column reference must match the DB's snake_case name (SnakeNamingStrategy).
    this.blockFilter.excludeBlocked(qb, viewerId, '"sp"."user_id"');

    if (query.kind) {
      qb.andWhere('sp.kind = :kind', { kind: query.kind });
    }
    if (query.query) {
      // Escape LIKE metacharacters so the term matches literally.
      const term = `%${query.query.replace(/[\\%_]/g, '\\$&')}%`;
      qb.andWhere('(sp.displayName ILIKE :term OR sp.tagline ILIKE :term)', {
        term,
      });
    }

    qb.orderBy('sp.displayName', 'ASC');
    const rows = await qb.getMany();
    return { items: rows.map(toCardDTO) };
  }

  // ---- internals -----------------------------------------------------------

  private async ownerDTO(sp: Subprofile): Promise<SubprofileView> {
    const items = await this.items.find({ where: { subprofileId: sp.id } });
    return toSubprofileDTO(sp, items);
  }

  private async loadItemsFor(
    ids: string[],
  ): Promise<Map<string, SubprofileItem[]>> {
    const byId = new Map<string, SubprofileItem[]>();
    if (!ids.length) {
      return byId;
    }
    const rows = await this.items.find({
      where: { subprofileId: In(ids) },
    });
    for (const row of rows) {
      const bucket = byId.get(row.subprofileId);
      if (bucket) {
        bucket.push(row);
      } else {
        byId.set(row.subprofileId, [row]);
      }
    }
    return byId;
  }

  private async generateSlug(
    userId: string,
    displayName: string,
  ): Promise<string> {
    const base = slugifyDisplayName(displayName);
    const existing = await this.subprofiles.find({
      where: { userId },
      select: { slug: true },
    });
    const taken = new Set(existing.map((e) => e.slug));
    if (!taken.has(base)) {
      return base;
    }
    let n = 2;
    while (taken.has(`${base}-${n}`)) {
      n += 1;
    }
    return `${base}-${n}`;
  }

  private async saveSubprofile(sp: Subprofile): Promise<void> {
    try {
      await this.subprofiles.save(sp);
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Duplicate slug (per owner) or handle (global) — surface as 409 so the
        // client re-picks (design spec §7).
        throw new ConflictException('slug or handle already in use');
      }
      throw err;
    }
  }
}
