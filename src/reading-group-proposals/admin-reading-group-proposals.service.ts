import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { ReadingGroupProposal } from './entities/reading-group-proposal.entity';
import {
  AdminReadingGroupProposalDTO,
  AdminReadingGroupProposalsPageDTO,
  toAdminReadingGroupProposalDTO,
} from './admin-reading-group-proposals-response';
import { ListAdminReadingGroupProposalsQuery } from './dto/list-admin-reading-group-proposals.query';

/** One page of the admin reading-group-proposal list. */
export const ADMIN_READING_GROUP_PROPOSALS_PAGE_SIZE = 20;

/**
 * Read model behind the admin dashboard's reading-group-proposal oversight
 * surface: every "Start your own group" a member has submitted, newest first,
 * optionally filtered by format, paginated.
 *
 * Every row is hand-mapped to `AdminReadingGroupProposalDTO` (never a raw
 * entity), and the proposing members are resolved in ONE batched profile lookup
 * across the whole page — never one query per row — mirroring
 * `AdminInvitesService`.
 */
@Injectable()
export class AdminReadingGroupProposalsService {
  constructor(
    @InjectRepository(ReadingGroupProposal)
    private readonly proposals: Repository<ReadingGroupProposal>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  async list(
    query: ListAdminReadingGroupProposalsQuery,
  ): Promise<AdminReadingGroupProposalsPageDTO> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const pageSize = ADMIN_READING_GROUP_PROPOSALS_PAGE_SIZE;

    const proposalQueryBuilder = this.proposals
      .createQueryBuilder('proposal')
      .orderBy('proposal.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    if (query.format) {
      proposalQueryBuilder.andWhere('proposal.format = :format', {
        format: query.format,
      });
    }

    const [rows, total] = await proposalQueryBuilder.getManyAndCount();
    if (!rows.length) {
      return { items: [], total, page, pageSize };
    }

    const memberLookup = new MemberLookup(this.profiles);
    const memberIds = [...new Set(rows.map((row) => row.memberId))];
    const refsByUserId = await memberLookup.byUserIds(memberIds);

    const items: AdminReadingGroupProposalDTO[] = rows.map((proposal) =>
      toAdminReadingGroupProposalDTO(
        proposal,
        refsByUserId.get(proposal.memberId) ?? null,
      ),
    );

    return { items, total, page, pageSize };
  }
}
