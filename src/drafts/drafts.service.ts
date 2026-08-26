import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { DraftDTO, toDraftDTO } from './draft-response';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { Draft, DraftPayload } from './entities/draft.entity';

@Injectable()
export class DraftsService {
  constructor(
    @InjectRepository(Draft) private readonly drafts: Repository<Draft>,
    private readonly dataSource: DataSource,
  ) {}

  // Page-based envelope (`{items,total,page,pageSize}`), matching the FE's
  // `getDrafts(page?)` which imports `Paginated` from `shared/api/refs.ts` —
  // NOT the cursor shape the spec's Tier 2 bullet mentions (that reference is
  // stale relative to the actual frontend code).
  async list(userId: string, page?: number): Promise<Paginated<DraftDTO>> {
    const normalizedPage = normalizePage(page);
    const qb = this.drafts
      .createQueryBuilder('d')
      .where('d.user_id = :userId', { userId })
      .orderBy('d.updated_at', 'DESC');

    return paginate(qb, normalizedPage, (rows) => rows.map(toDraftDTO));
  }

  /**
   * Creates a draft under the CALLER-SUPPLIED id (see the `Draft` entity doc).
   *
   * `insert`, never `save`. TypeORM's `save` on an entity whose primary key
   * already exists performs an UPDATE, so a POST that reused an id — a client
   * that regenerates ids, or a retry after a create whose response was lost —
   * silently replaced a DIFFERENT draft's whole payload with this one's. An
   * INSERT lets the composite `(id, user_id)` primary key do its job, and the
   * unique violation becomes an honest 409 the client can react to.
   */
  async create(userId: string, dto: CreateDraftDto): Promise<DraftDTO> {
    const draft = this.drafts.create({
      id: dto.id,
      userId,
      kind: dto.kind,
      payload: toPayload(dto),
      // Set explicitly rather than left to the column default, so the returned
      // DTO carries the base version the client will send back on its first
      // patch instead of `undefined`.
      version: 0,
    });
    try {
      await this.drafts.insert(draft);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('You already have a draft with this id.');
      }
      throw error;
    }
    return toDraftDTO(draft);
  }

  /**
   * Patches a draft under an optimistic-concurrency precondition.
   *
   * The patch MERGES onto the stored payload, so two tabs autosaving the same
   * draft used to interleave last-write-wins with no signal to either. The
   * write now claims the row with `UPDATE ... WHERE version = :baseVersion`
   * inside the same transaction as the save: a concurrent request blocks on
   * that row lock and, once through, no longer matches — so it gets a 409
   * instead of quietly winning.
   *
   * A client that sends no `expectedVersion` is still not refused (the field is
   * staged in — see `UpdateDraftDto`); it gets the load→write race closed
   * within the request, just not the read→edit→write one across requests.
   */
  async update(
    userId: string,
    id: string,
    dto: UpdateDraftDto,
  ): Promise<DraftDTO> {
    const draft = await this.loadOr404(userId, id);

    const baseVersion = draft.version;
    const isStaleExpectation =
      dto.expectedVersion !== undefined && dto.expectedVersion !== baseVersion;
    if (isStaleExpectation) {
      throw new ConflictException({
        message:
          'This draft changed since you loaded it. Reload before saving again.',
        currentVersion: baseVersion,
      });
    }

    const nextKind = dto.kind !== undefined ? dto.kind : draft.kind;
    const nextPayload = mergePayload(draft.payload, dto);

    const saved = await this.dataSource.transaction(async (manager) => {
      const draftRepository = manager.getRepository(Draft);
      const claim = await draftRepository.update(
        { id, userId, version: baseVersion },
        { version: baseVersion + 1 },
      );
      if (claim.affected === 0) return null;
      draft.kind = nextKind;
      draft.payload = nextPayload;
      draft.version = baseVersion + 1;
      return await draftRepository.save(draft);
    });

    if (saved === null) {
      throw new ConflictException({
        message:
          'This draft changed while you were saving. Reload before saving again.',
      });
    }
    return toDraftDTO(saved);
  }

  /**
   * One draft by its client-minted id, or 404.
   *
   * Added for autosaving composers (SOC-13's forum composer is the first): a
   * surface that saves under a KNOWN id needs to ask "is there already one of
   * these?" on mount, and paging `list()` looking for it is both wrong (the
   * draft can fall off page one) and wasteful. Scoped to the caller by the
   * composite `(id, user_id)` key, exactly like `update`/`remove`.
   */
  async get(userId: string, id: string): Promise<DraftDTO> {
    return toDraftDTO(await this.loadOr404(userId, id));
  }

  async remove(userId: string, id: string): Promise<void> {
    const draft = await this.loadOr404(userId, id);
    await this.drafts.remove(draft);
  }

  private async loadOr404(userId: string, id: string): Promise<Draft> {
    const draft = await this.drafts.findOne({ where: { id, userId } });
    if (!draft) {
      throw new NotFoundException('Draft not found');
    }
    return draft;
  }
}

function toPayload(dto: CreateDraftDto): DraftPayload {
  return {
    kindVariant: dto.kindVariant,
    title: dto.title,
    desc: dto.desc,
    progress: dto.progress,
    ready: dto.ready,
    category: dto.category,
    status: dto.status,
    href: dto.href,
    editedMinutes: dto.editedMinutes,
    deadlineDays: dto.deadlineDays,
    sortTitle: dto.sortTitle,
    searchText: dto.searchText,
  };
}

// `deadlineDays` needs explicit `undefined`-vs-`null` handling: `null` is a
// meaningful "clear the deadline" update, so `??` (which also falls through
// on `null`) would silently drop it. Every other field has no `null` sense in
// its type, so `??` correctly preserves an explicit `false`/`0`/`""` while
// still falling back to the existing value when the field wasn't sent.
function mergePayload(
  existing: DraftPayload,
  dto: UpdateDraftDto,
): DraftPayload {
  return {
    kindVariant: dto.kindVariant ?? existing.kindVariant,
    title: dto.title ?? existing.title,
    desc: dto.desc ?? existing.desc,
    progress: dto.progress ?? existing.progress,
    ready: dto.ready ?? existing.ready,
    category: dto.category ?? existing.category,
    status: dto.status ?? existing.status,
    href: dto.href ?? existing.href,
    editedMinutes: dto.editedMinutes ?? existing.editedMinutes,
    deadlineDays:
      dto.deadlineDays !== undefined ? dto.deadlineDays : existing.deadlineDays,
    sortTitle: dto.sortTitle ?? existing.sortTitle,
    searchText: dto.searchText ?? existing.searchText,
  };
}
