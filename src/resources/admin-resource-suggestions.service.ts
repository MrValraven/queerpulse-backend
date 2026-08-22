import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { PAGE_SIZE } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';
import {
  AdminResourceSuggestionDTO,
  AdminResourceSuggestionsPageDTO,
  toAdminResourceSuggestionDTO,
} from './resource-suggestion-response';
import { ListAdminResourceSuggestionsQuery } from './dto/list-admin-resource-suggestions.query';

/**
 * Read model + decision transitions behind the admin resource-suggestion
 * review queue (CNT-14) — mirrors `AdminReadingGroupProposalsService`
 * exactly, including resolving suggesters in ONE batched profile lookup per
 * page, never one query per row.
 */
@Injectable()
export class AdminResourceSuggestionsService {
  constructor(
    @InjectRepository(ResourceSuggestion)
    private readonly suggestions: Repository<ResourceSuggestion>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async list(
    query: ListAdminResourceSuggestionsQuery,
  ): Promise<AdminResourceSuggestionsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;

    const qb = this.suggestions
      .createQueryBuilder('suggestion')
      .orderBy('suggestion.createdAt', 'DESC')
      .skip((page - 1) * PAGE_SIZE)
      .take(PAGE_SIZE);

    if (query.category) {
      qb.andWhere('suggestion.category = :category', {
        category: query.category,
      });
    }
    if (query.status) {
      qb.andWhere('suggestion.status = :status', { status: query.status });
    }

    const [rows, total] = await qb.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize: PAGE_SIZE };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const refsByUserId = await memberLookup.byUserIds(memberIds);

    const items = rows.map((suggestion) =>
      toAdminResourceSuggestionDTO(
        suggestion,
        refsByUserId.get(suggestion.memberId) ?? null,
      ),
    );

    return { items, total, page, pageSize: PAGE_SIZE };
  }

  /**
   * Approve a suggestion — record it as accepted. Deliberately does NOT
   * create a `ResourceListing`: this service holds no `Repository<ResourceListing>`
   * at all, so it structurally cannot write one. An admin who has actually
   * verified the organisation creates the real listing by hand via
   * `AdminResourceListingsController`, using this suggestion as a reference.
   */
  approve(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Approved,
      adminUserId,
      note,
    );
  }

  decline(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Declined,
      adminUserId,
      note,
    );
  }

  archive(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    return this.decide(
      id,
      ResourceSuggestionStatus.Archived,
      adminUserId,
      note,
    );
  }

  private async decide(
    id: string,
    status: ResourceSuggestionStatus,
    adminUserId: string,
    note?: string,
  ): Promise<AdminResourceSuggestionDTO> {
    const suggestion = await this.suggestions.findOne({ where: { id } });
    if (!suggestion) {
      throw new NotFoundException('Resource suggestion not found.');
    }

    suggestion.status = status;
    suggestion.decidedAt = new Date();
    suggestion.decidedBy = adminUserId;
    suggestion.decisionNote = note?.trim() ? note.trim() : null;
    const saved = await this.suggestions.save(suggestion);

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([saved.memberId]);

    return toAdminResourceSuggestionDTO(
      saved,
      refsByUserId.get(saved.memberId) ?? null,
    );
  }
}
