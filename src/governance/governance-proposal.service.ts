import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  GovernanceProposal,
  GovernanceProposalStatus,
  GovernanceProposalType,
} from './entities/governance-proposal.entity';
import { GovernanceVote } from './entities/governance-vote.entity';
import { CreateGovernanceProposalDto } from './dto/create-governance-proposal.dto';
import { CastGovernanceVoteDto } from './dto/cast-governance-vote.dto';
import {
  GovernanceProposalDTO,
  ProposalTally,
  proposalOutcome,
  toGovernanceProposalDTO,
} from './governance-proposal-response';

/**
 * Real member-vote proposals backing the Governance page's "two-thirds
 * community vote" (council removal) and "the community will vote on it"
 * (funding-policy change) promises — modeled directly on
 * `RoadmapService`'s member-voting pattern: tallies are computed live from
 * `governance_votes` on every read, never a denormalized counter, and a
 * repeat vote is a silent no-op rather than a 409.
 */
@Injectable()
export class GovernanceProposalService {
  constructor(
    @InjectRepository(GovernanceProposal)
    private readonly proposals: Repository<GovernanceProposal>,
    @InjectRepository(GovernanceVote)
    private readonly votes: Repository<GovernanceVote>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
  ) {}

  // Live for/against counts for a batch of proposals, keyed by proposalId. A
  // proposal with zero votes of a given choice simply has that count absent
  // from its row (callers `?? 0`) — mirrors `RoadmapService.liveVoteCounts`.
  private async tallyFor(
    proposalIds: string[],
  ): Promise<Map<string, ProposalTally>> {
    const tallies = new Map<string, ProposalTally>();
    if (proposalIds.length === 0) return tallies;
    const rows = await this.votes
      .createQueryBuilder('vote')
      .select('vote.proposalId', 'proposalId')
      .addSelect('vote.choice', 'choice')
      .addSelect('COUNT(*)', 'count')
      .where('vote.proposalId IN (:...proposalIds)', { proposalIds })
      .groupBy('vote.proposalId')
      .addGroupBy('vote.choice')
      .getRawMany<{ proposalId: string; choice: string; count: string }>();
    for (const row of rows) {
      const tally = tallies.get(row.proposalId) ?? { for: 0, against: 0 };
      if (row.choice === 'for') tally.for = Number(row.count);
      else tally.against = Number(row.count);
      tallies.set(row.proposalId, tally);
    }
    return tallies;
  }

  // Lazily flips an `open` proposal whose `closesAt` has passed to its final
  // `passed`/`failed` outcome and persists the write, mutating the passed-in
  // entity so the caller's response reflects it immediately. A single
  // one-way transition (open → resolved) is cheap enough to check on every
  // read, unlike the invite-expiry sweep elsewhere in this backend (which
  // exists because *filtering* a large, frequently-queried table by a
  // transient expiry is expensive) — so this writes directly on read rather
  // than adding a parallel `@Cron` reconciler for one boolean flip.
  private async resolveIfClosed(
    proposal: GovernanceProposal,
    tally: ProposalTally,
  ): Promise<GovernanceProposal> {
    if (proposal.status !== GovernanceProposalStatus.Open) return proposal;
    if (proposal.closesAt.getTime() > Date.now()) return proposal;
    const outcome = proposalOutcome(tally);
    proposal.status = outcome;
    await this.proposals.update(proposal.id, { status: outcome });
    return proposal;
  }

  private async targetRefsFor(
    proposalRows: GovernanceProposal[],
  ): Promise<Map<string, MemberRef>> {
    const targetIds = [
      ...new Set(
        proposalRows
          .map((row) => row.targetMemberId)
          .filter((id): id is string => id !== null),
      ),
    ];
    return new MemberLookup(this.profiles).byUserIds(targetIds);
  }

  async createProposal(
    dto: CreateGovernanceProposalDto,
    actorId: string,
  ): Promise<GovernanceProposalDTO> {
    if (
      dto.type === GovernanceProposalType.CouncilRemoval &&
      !dto.targetMemberId
    ) {
      throw new BadRequestException(
        'targetMemberId is required for a council_removal proposal',
      );
    }
    const opensAt = new Date(dto.opensAt);
    const closesAt = new Date(dto.closesAt);
    if (!(closesAt.getTime() > opensAt.getTime())) {
      throw new BadRequestException('closesAt must be after opensAt');
    }

    const saved = await this.proposals.save(
      this.proposals.create({
        type: dto.type,
        title: dto.title,
        description: dto.description,
        targetMemberId: dto.targetMemberId ?? null,
        status: GovernanceProposalStatus.Open,
        opensAt,
        closesAt,
        createdByMemberId: actorId,
      }),
    );

    const targetRefs = await this.targetRefsFor([saved]);
    return toGovernanceProposalDTO(
      saved,
      { for: 0, against: 0 },
      null,
      saved.targetMemberId
        ? (targetRefs.get(saved.targetMemberId) ?? null)
        : null,
    );
  }

  /** Every proposal, open and resolved alike — newest first. The frontend
   *  groups by `status` for the two-shelf "open" / "resolved" layout. */
  async listProposals(memberId: string): Promise<GovernanceProposalDTO[]> {
    const rows = await this.proposals.find({ order: { createdAt: 'DESC' } });
    if (rows.length === 0) return [];

    const proposalIds = rows.map((row) => row.id);
    const tallies = await this.tallyFor(proposalIds);
    const resolvedRows = await Promise.all(
      rows.map((row) =>
        this.resolveIfClosed(
          row,
          tallies.get(row.id) ?? { for: 0, against: 0 },
        ),
      ),
    );

    const myVoteRows = await this.votes.find({
      where: { memberId, proposalId: In(proposalIds) },
    });
    const myVoteByProposal = new Map(
      myVoteRows.map((vote) => [vote.proposalId, vote.choice]),
    );
    const targetRefs = await this.targetRefsFor(resolvedRows);

    return resolvedRows.map((row) =>
      toGovernanceProposalDTO(
        row,
        tallies.get(row.id) ?? { for: 0, against: 0 },
        myVoteByProposal.get(row.id) ?? null,
        row.targetMemberId
          ? (targetRefs.get(row.targetMemberId) ?? null)
          : null,
      ),
    );
  }

  async getProposal(
    id: string,
    memberId: string,
  ): Promise<GovernanceProposalDTO> {
    const row = await this.proposals.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Proposal not found');

    const tally = (await this.tallyFor([id])).get(id) ?? { for: 0, against: 0 };
    const resolvedRow = await this.resolveIfClosed(row, tally);
    const myVote = await this.votes.findOne({
      where: { proposalId: id, memberId },
    });
    const targetRefs = await this.targetRefsFor([resolvedRow]);

    return toGovernanceProposalDTO(
      resolvedRow,
      tally,
      myVote?.choice ?? null,
      resolvedRow.targetMemberId
        ? (targetRefs.get(resolvedRow.targetMemberId) ?? null)
        : null,
    );
  }

  async castVote(
    memberId: string,
    proposalId: string,
    dto: CastGovernanceVoteDto,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.proposals.findOne({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');

    const now = Date.now();
    if (now < proposal.opensAt.getTime()) {
      throw new BadRequestException(
        'Voting has not opened for this proposal yet',
      );
    }
    if (
      proposal.status !== GovernanceProposalStatus.Open ||
      now >= proposal.closesAt.getTime()
    ) {
      throw new BadRequestException('Voting is closed for this proposal');
    }

    try {
      await this.votes.save(
        this.votes.create({ proposalId, memberId, choice: dto.choice }),
      );
    } catch (error) {
      // Idempotent, like `RoadmapService.castVote`: a repeat vote loses on
      // `UQ_governance_votes_proposal_member` — that IS the "already voted"
      // state this call converges on. The original choice sticks; there is
      // no vote-changing.
      if (!isUniqueViolation(error, 'UQ_governance_votes_proposal_member')) {
        throw error;
      }
    }

    return this.getProposal(proposalId, memberId);
  }
}
