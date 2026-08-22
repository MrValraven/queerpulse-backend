import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
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
    // Freeze the counts the outcome was decided on, in the same write
    // (BE-COM-31). Without this the displayed for/against keeps tracking live
    // vote rows, which shrink when a voter erases their account — so a
    // resolved proposal could end up rendering a percentage that contradicts
    // its own recorded outcome.
    proposal.finalFor = tally.for;
    proposal.finalAgainst = tally.against;
    await this.proposals.update(proposal.id, {
      status: outcome,
      finalFor: tally.for,
      finalAgainst: tally.against,
    });
    return proposal;
  }

  /**
   * What to display for a proposal: the frozen snapshot once it has resolved,
   * the live count while it is still open (BE-COM-31).
   *
   * A resolved proposal from before the snapshot columns existed, and whose
   * migration backfill found no vote rows, falls back to the live tally — the
   * counts were never recorded, so there is nothing better to show.
   */
  private displayTally(
    proposal: GovernanceProposal,
    liveTally: ProposalTally,
  ): ProposalTally {
    if (
      proposal.status !== GovernanceProposalStatus.Open &&
      proposal.finalFor !== null &&
      proposal.finalAgainst !== null
    ) {
      return { for: proposal.finalFor, against: proposal.finalAgainst };
    }
    return liveTally;
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
   *  groups by `status` for the two-shelf "open" / "resolved" layout.
   *
   *  Bounded by `DEFAULT_LIST_LIMIT` (BE-COM-36): this returned the whole
   *  `governance_proposals` table with no `take` at all, and each row then
   *  fans out into a tally, a lazy `resolveIfClosed` write, and a target-ref
   *  lookup. The response shape stays a plain array (no pagination envelope),
   *  so the cap is invisible to today's callers — the governance page has
   *  nowhere near 200 proposals — while making the query bounded. Swap for a
   *  cursor page if the archive ever approaches the cap. */
  async listProposals(memberId: string): Promise<GovernanceProposalDTO[]> {
    const rows = await this.proposals.find({
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
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
        this.displayTally(row, tallies.get(row.id) ?? { for: 0, against: 0 }),
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
      this.displayTally(resolvedRow, tally),
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
    // Nobody votes on a proposal about themselves (BE-COM-10). A council
    // removal names its subject in `targetMemberId`, and letting that member
    // vote on their own removal is the plainest conflict of interest the
    // process has.
    if (proposal.targetMemberId && proposal.targetMemberId === memberId) {
      throw new ForbiddenException(
        'You cannot vote on a proposal about yourself',
      );
    }

    // A member may change their mind while the window is open. The unique
    // violation used to be swallowed instead, which meant a member who voted
    // `for` and then sent `against` got HTTP 201, `myVote: 'for'`, and a tally
    // that had not moved — the API reporting success for a write it silently
    // discarded (BE-COM-09). `ON CONFLICT DO UPDATE` on
    // `UQ_governance_votes_proposal_member` makes the second cast REPLACE the
    // first, so the response the caller reads back is always the vote they
    // just sent. Re-sending the same choice stays a no-op.
    await this.votes
      .createQueryBuilder()
      .insert()
      .into(GovernanceVote)
      .values({ proposalId, memberId, choice: dto.choice })
      .orUpdate(['choice'], ['proposal_id', 'member_id'])
      .execute();

    return this.getProposal(proposalId, memberId);
  }
}
