import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { DraftDTO, toDraftDTO } from './draft-response';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { Draft, DraftPayload } from './entities/draft.entity';

@Injectable()
export class DraftsService {
  constructor(
    @InjectRepository(Draft) private readonly drafts: Repository<Draft>,
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

  async create(userId: string, dto: CreateDraftDto): Promise<DraftDTO> {
    const saved = await this.drafts.save(
      this.drafts.create({
        id: dto.id,
        userId,
        kind: dto.kind,
        payload: toPayload(dto),
      }),
    );
    return toDraftDTO(saved);
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateDraftDto,
  ): Promise<DraftDTO> {
    const draft = await this.loadOr404(userId, id);

    if (dto.kind !== undefined) draft.kind = dto.kind;
    draft.payload = mergePayload(draft.payload, dto);

    const saved = await this.drafts.save(draft);
    return toDraftDTO(saved);
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
