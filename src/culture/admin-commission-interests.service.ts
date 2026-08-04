import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { CommissionInterest } from './entities/commission-interest.entity';
import {
  AdminCommissionInterestDTO,
  AdminCommissionInterestsPageDTO,
  toAdminCommissionInterestDTO,
} from './admin-commission-interests-response';
import { ListAdminCommissionInterestsQuery } from './dto/list-admin-commission-interests.query';

/** One page of the admin commission-interest list. */
export const ADMIN_COMMISSION_INTERESTS_PAGE_SIZE = 20;

/**
 * Read model behind the admin dashboard's commission-interest oversight surface:
 * every "express interest" a member has sent on the Commission Board, newest
 * first, optionally filtered by category, paginated.
 *
 * Every row is hand-mapped to `AdminCommissionInterestDTO` (never a raw entity),
 * and the submitting members are resolved in ONE batched profile lookup across
 * the whole page — never one query per row — mirroring `AdminInvitesService`.
 */
@Injectable()
export class AdminCommissionInterestsService {
  constructor(
    @InjectRepository(CommissionInterest)
    private readonly commissionInterests: Repository<CommissionInterest>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async list(
    query: ListAdminCommissionInterestsQuery,
  ): Promise<AdminCommissionInterestsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_COMMISSION_INTERESTS_PAGE_SIZE;

    const interestQueryBuilder = this.commissionInterests
      .createQueryBuilder('interest')
      .orderBy('interest.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.category) {
      interestQueryBuilder.andWhere('interest.commissionCategory = :category', {
        category: query.category,
      });
    }

    const [rows, total] = await interestQueryBuilder.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const refsByUserId = await memberLookup.byUserIds(memberIds);

    const items: AdminCommissionInterestDTO[] = rows.map((interest) =>
      toAdminCommissionInterestDTO(
        interest,
        refsByUserId.get(interest.memberId) ?? null,
      ),
    );

    return { items, total, page, pageSize };
  }
}
