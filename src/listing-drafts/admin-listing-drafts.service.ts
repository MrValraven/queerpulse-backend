import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { normalizePage, paginate, Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { ListAdminListingDraftsQuery } from './dto/list-admin-listing-drafts.query';
import { ListingDraft } from './entities/listing-draft.entity';
import {
  AdminListingDraftDetailDTO,
  AdminListingDraftDTO,
  toAdminListingDraftDetailDTO,
  toAdminListingDraftDTO,
} from './listing-draft-response';

/**
 * The Admin-only read over every member's unfinished listing drafts, so staff
 * can offer a hand to someone who stalled partway through the wizard. Kept
 * apart from `ListingDraftsService`, whose every method is scoped to the
 * caller's own rows: an unscoped read sitting beside them would be one missed
 * `userId` filter away from a member reading someone else's draft.
 */
@Injectable()
export class AdminListingDraftsService {
  constructor(
    @InjectRepository(ListingDraft)
    private readonly listingDrafts: Repository<ListingDraft>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  /**
   * `GET /admin/listing-drafts` — most recently edited first, paginated. A
   * draft is deleted when its listing is submitted or the member discards it
   * (and cascades with their account), so every row here is still unfinished.
   * Owners on the page resolve in ONE batched profile lookup, never N+1.
   */
  async list(
    query: ListAdminListingDraftsQuery = {},
  ): Promise<Paginated<AdminListingDraftDTO>> {
    const page = normalizePage(query.page);
    const draftsQuery = this.listingDrafts
      .createQueryBuilder('draft')
      // `updated_at` alone is not a total order for offset pagination (two
      // autosaves can share a timestamp), so `id` breaks the tie, as in
      // `ListingClaimsService.listPending`.
      .orderBy('draft.updated_at', 'DESC')
      .addOrderBy('draft.id', 'DESC');

    return paginate(draftsQuery, page, async (rows) => {
      if (!rows.length) return [];
      const ownerIds = [...new Set(rows.map((row) => row.userId))];
      const refs = await new MemberLookup(this.profiles).byUserIds(ownerIds);
      return rows.map((row) =>
        toAdminListingDraftDTO(row, refs.get(row.userId) ?? null),
      );
    });
  }

  /**
   * `GET /admin/listing-drafts/:id` — one draft's summary plus the business
   * half of its wizard state, for "Finish as a team listing". Read-only: the
   * member's row is never written from here, so their own draft stays as they
   * left it. A 404 once they have submitted or discarded it, since the row is
   * deleted then.
   */
  async getOne(id: string): Promise<AdminListingDraftDetailDTO> {
    const draft = await this.listingDrafts.findOne({ where: { id } });
    if (!draft) throw new NotFoundException('Listing draft not found');
    const refs = await new MemberLookup(this.profiles).byUserIds([
      draft.userId,
    ]);
    return toAdminListingDraftDetailDTO(draft, refs.get(draft.userId) ?? null);
  }
}
