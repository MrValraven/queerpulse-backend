import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  ReadingGroupProposal,
  ReadingGroupProposalStatus,
} from './entities/reading-group-proposal.entity';
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

  /**
   * Approve a proposal — record it as accepted, stamping who/when and an
   * optional note.
   */
  approve(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    return this.decide(id, ReadingGroupProposalStatus.Approved, adminUserId, note);
  }

  /** Decline a proposal — record it as rejected, with the who/when and note. */
  decline(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    return this.decide(id, ReadingGroupProposalStatus.Declined, adminUserId, note);
  }

  /** Archive a proposal — filed away without an accept/reject verdict. */
  archive(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    return this.decide(id, ReadingGroupProposalStatus.Archived, adminUserId, note);
  }

  /**
   * Shared state transition for the three admin decisions: load the proposal
   * (404 if gone), stamp the new `status` plus who/when, normalise an empty note
   * to null, persist, then hand-map to the DTO with the proposer resolved —
   * never a raw entity.
   */
  private async decide(
    id: string,
    status: ReadingGroupProposalStatus,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    const proposal = await this.proposals.findOne({ where: { id } });
    if (!proposal) {
      throw new NotFoundException('Reading-group proposal not found.');
    }

    proposal.status = status;
    proposal.decidedAt = new Date();
    proposal.decidedBy = adminUserId;
    proposal.decisionNote = note?.trim() ? note.trim() : null;
    const saved = await this.proposals.save(proposal);

    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([saved.memberId]);

    return toAdminReadingGroupProposalDTO(
      saved,
      refsByUserId.get(saved.memberId) ?? null,
    );
  }
}
