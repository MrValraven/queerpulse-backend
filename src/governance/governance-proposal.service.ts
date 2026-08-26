import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { DEFAULT_LIST_LIMIT } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import {
  GovernanceProposal,
  GovernanceProposalStatus,
  GovernanceProposalType,
} from './entities/governance-proposal.entity';
import { GovernanceProposalCosignature } from './entities/governance-proposal-cosignature.entity';
import { GovernanceVote } from './entities/governance-vote.entity';
import { ApproveGovernanceMotionDto } from './dto/approve-governance-motion.dto';
import { CastGovernanceVoteDto } from './dto/cast-governance-vote.dto';
import { CreateGovernanceMotionDto } from './dto/create-governance-motion.dto';
import { CreateGovernanceProposalDto } from './dto/create-governance-proposal.dto';
import { RejectGovernanceMotionDto } from './dto/reject-governance-motion.dto';
import {
  COSIGNATURE_THRESHOLD,
  GATHERING_WINDOW_DAYS,
  GovernanceProposalDTO,
  ProposalTally,
  proposalOutcome,
  quorumRequiredFor,
  toGovernanceProposalDTO,
} from './governance-proposal-response';

/**
 * How many motions one member may have gathering co-signatures at once
 * (GOV-01).
 *
 * A concurrency cap rather than a time window ("one motion per day") on
 * purpose: the thing worth preventing is a single member papering the
 * gathering shelf with motions nobody has signed, and that is a question of
 * how many are STANDING, not how fast they arrived. A time window punishes the
 * member who files three genuine motions in one sitting after a community
 * meeting, while still letting a determined flooder post one a day forever. A
 * concurrency cap does the opposite: the shelf stays readable, and the member
 * gets another slot the moment one of their motions is screened, rejected, or
 * lapses. Motions past `gathering` do not count against it.
 */
const MAX_GATHERING_MOTIONS_PER_MEMBER = 3;

/** Rows flipped per UPDATE in `lapseExpiredMotions`, bounding lock/WAL cost
 *  per batch (mirrors `HousingListingExpirySweeperService.SWEEP_BATCH_SIZE`). */
const LAPSE_BATCH_SIZE = 500;
const LAPSE_MAX_BATCHES = 20;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What `cosign` hands back: the motion as the caller should now see it, plus
 * whether THIS request is the one that carried it over the threshold.
 *
 * The flag is separate from the DTO on purpose. `status: 'screening'` is true
 * for every later reader of the motion, so it cannot tell the controller
 * whether to page staff; only the request that actually made the transition
 * should do that, exactly once.
 */
export interface CosignatureResult {
  proposal: GovernanceProposalDTO;
  hasReachedThreshold: boolean;
}

/**
 * Real member-vote proposals backing the Governance page's "two-thirds
 * community vote" (council removal) and "the community will vote on it"
 * (funding-policy change) promises — modeled directly on
 * `RoadmapService`'s member-voting pattern: tallies are computed live from
 * `governance_votes` on every read, never a denormalized counter, and a
 * repeat vote is a silent no-op rather than a 409.
 *
 * Member motions (GOV-01) hang off the same table and the same reads. A member
 * files a motion, it gathers co-signatures, staff screen it, and only then
 * does it become an ordinary `open` ballot that the vote path above already
 * knows how to run. Everything before that ballot is state on this row plus
 * `governance_proposal_cosignatures`; nothing about voting had to change.
 */
@Injectable()
export class GovernanceProposalService {
  constructor(
    @InjectRepository(GovernanceProposal)
    private readonly proposals: Repository<GovernanceProposal>,
    @InjectRepository(GovernanceVote)
    private readonly votes: Repository<GovernanceVote>,
    @InjectRepository(GovernanceProposalCosignature)
    private readonly cosignatures: Repository<GovernanceProposalCosignature>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    // `UsersService.countActiveMembers()` backs quorum. Injected rather than
    // counting `users` through a local repository: `GovernanceModule` already
    // imports `UsersModule` for the same service (the COM-4 health stat) and
    // `UsersModule` imports nothing from governance, so there is no cycle to
    // work around — and the service's 60s cache means the list path does not
    // pay for a `COUNT(*)` over an unindexed `status` on every read.
    private readonly users: UsersService,
    private readonly dataSource: DataSource,
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

  /**
   * Live co-signature counts for a batch of motions, keyed by proposalId —
   * the same shape and the same single grouped query as `tallyFor`, for the
   * same reason: the count is derived from rows on every read rather than kept
   * as a denormalized counter that an erased account would leave wrong.
   *
   * A motion with no signatures is simply absent from the map (callers `?? 0`).
   */
  private async cosignatureCountsFor(
    proposalIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (proposalIds.length === 0) return counts;
    const rows = await this.cosignatures
      .createQueryBuilder('cosignature')
      .select('cosignature.proposalId', 'proposalId')
      .addSelect('COUNT(*)', 'count')
      .where('cosignature.proposalId IN (:...proposalIds)', { proposalIds })
      .groupBy('cosignature.proposalId')
      .getRawMany<{ proposalId: string; count: string }>();
    for (const row of rows) {
      counts.set(row.proposalId, Number(row.count));
    }
    return counts;
  }

  /**
   * The quorum every proposal in THIS request is measured against.
   *
   * Deliberately called once per request and threaded through, never once per
   * proposal: quorum is a function of the community, not of the row, so a list
   * of 200 proposals must not become 200 member counts.
   */
  private async currentQuorumRequired(): Promise<number> {
    const activeMemberCount = await this.users.countActiveMembers();
    return quorumRequiredFor(activeMemberCount);
  }

  private tallyOf(
    tallies: Map<string, ProposalTally>,
    proposalId: string,
  ): ProposalTally {
    return tallies.get(proposalId) ?? { for: 0, against: 0 };
  }

  // Lazily flips an `open` proposal whose `closesAt` has passed to its final
  // `passed`/`failed` outcome and persists the write, mutating the passed-in
  // entity so the caller's response reflects it immediately. A single
  // one-way transition (open → resolved) is cheap enough to check on every
  // read, unlike the invite-expiry sweep elsewhere in this backend (which
  // exists because *filtering* a large, frequently-queried table by a
  // transient expiry is expensive) — so this writes directly on read rather
  // than adding a parallel `@Cron` reconciler for one boolean flip.
  //
  // Only an `open` proposal resolves. A motion still `gathering` or in
  // `screening` has no ballot to tally and no meaningful `closesAt` yet (see
  // `createMotion`), and `rejected`/`lapsed` are already terminal, so all four
  // fall out at the status guard untouched.
  private async resolveIfClosed(
    proposal: GovernanceProposal,
    tally: ProposalTally,
    quorumRequired: number,
  ): Promise<GovernanceProposal> {
    if (proposal.status !== GovernanceProposalStatus.Open) return proposal;
    if (proposal.closesAt.getTime() > Date.now()) return proposal;
    const outcome = proposalOutcome(tally, quorumRequired);
    proposal.status = outcome;
    // Freeze the counts the outcome was decided on, in the same write
    // (BE-COM-31). Without this the displayed for/against keeps tracking live
    // vote rows, which shrink when a voter erases their account — so a
    // resolved proposal could end up rendering a percentage that contradicts
    // its own recorded outcome.
    //
    // `finalQuorumRequired` is frozen in that SAME write for the mirror-image
    // reason: quorum is a percentage of the live active membership, so a bar
    // re-derived at render time would silently re-judge a decided proposal
    // every time the community grew.
    proposal.finalFor = tally.for;
    proposal.finalAgainst = tally.against;
    proposal.finalQuorumRequired = quorumRequired;
    await this.proposals.update(proposal.id, {
      status: outcome,
      finalFor: tally.for,
      finalAgainst: tally.against,
      finalQuorumRequired: quorumRequired,
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

  /**
   * Every member a batch of proposals needs to display: the `targetMemberId`
   * of a council removal AND the `proposedByMemberId` of a member motion,
   * resolved through ONE `MemberLookup` batch. Both id sets go into the same
   * `IN (...)` so adding the proposer byline cost no extra query.
   */
  private async memberRefsFor(
    proposalRows: GovernanceProposal[],
  ): Promise<Map<string, MemberRef>> {
    const memberIds = new Set<string>();
    for (const row of proposalRows) {
      if (row.targetMemberId) memberIds.add(row.targetMemberId);
      if (row.proposedByMemberId) memberIds.add(row.proposedByMemberId);
    }
    return new MemberLookup(this.profiles).byUserIds([...memberIds]);
  }

  /**
   * The one read path every list and detail response goes through: resolve any
   * newly-closed ballot, then map rows → DTOs.
   *
   * Every per-proposal fact is fetched as a single batched query over the
   * whole page (tallies, the caller's own votes, co-signature counts, the
   * caller's own co-signatures, member refs) and the quorum is read once, so
   * the query count is flat in the number of proposals. Adding a per-row
   * lookup here is how this turns into an N+1.
   */
  private async mapProposals(
    rows: GovernanceProposal[],
    memberId: string,
  ): Promise<GovernanceProposalDTO[]> {
    if (rows.length === 0) return [];
    const proposalIds = rows.map((row) => row.id);

    const [tallies, currentQuorumRequired] = await Promise.all([
      this.tallyFor(proposalIds),
      this.currentQuorumRequired(),
    ]);
    const resolvedRows = await Promise.all(
      rows.map((row) =>
        this.resolveIfClosed(
          row,
          this.tallyOf(tallies, row.id),
          currentQuorumRequired,
        ),
      ),
    );

    const [myVoteRows, cosignatureCounts, myCosignatureRows, memberRefs] =
      await Promise.all([
        this.votes.find({ where: { memberId, proposalId: In(proposalIds) } }),
        this.cosignatureCountsFor(proposalIds),
        this.cosignatures.find({
          where: { memberId, proposalId: In(proposalIds) },
        }),
        this.memberRefsFor(resolvedRows),
      ]);
    const myVoteByProposal = new Map(
      myVoteRows.map((vote) => [vote.proposalId, vote.choice]),
    );
    const cosignedProposalIds = new Set(
      myCosignatureRows.map((cosignature) => cosignature.proposalId),
    );

    return resolvedRows.map((row) =>
      toGovernanceProposalDTO({
        proposal: row,
        tally: this.displayTally(row, this.tallyOf(tallies, row.id)),
        myVote: myVoteByProposal.get(row.id) ?? null,
        targetMember: row.targetMemberId
          ? (memberRefs.get(row.targetMemberId) ?? null)
          : null,
        proposedByMember: row.proposedByMemberId
          ? (memberRefs.get(row.proposedByMemberId) ?? null)
          : null,
        cosignatureCount: cosignatureCounts.get(row.id) ?? 0,
        hasCosigned: cosignedProposalIds.has(row.id),
        currentQuorumRequired,
      }),
    );
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

    const memberRefs = await this.memberRefsFor([saved]);
    // An admin-opened proposal has no co-signature drive at all, so the
    // motion-only fields are zero/null by definition rather than looked up.
    return toGovernanceProposalDTO({
      proposal: saved,
      tally: { for: 0, against: 0 },
      myVote: null,
      targetMember: saved.targetMemberId
        ? (memberRefs.get(saved.targetMemberId) ?? null)
        : null,
      proposedByMember: null,
      cosignatureCount: 0,
      hasCosigned: false,
      currentQuorumRequired: await this.currentQuorumRequired(),
    });
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
    return this.mapProposals(rows, memberId);
  }

  async getProposal(
    id: string,
    memberId: string,
  ): Promise<GovernanceProposalDTO> {
    const row = await this.proposals.findOne({ where: { id } });
    if (!row) throw new NotFoundException('Proposal not found');
    const [dto] = await this.mapProposals([row], memberId);
    // `mapProposals` returns one DTO per row it was given, so a single-row
    // call always yields index 0. The guard is here for the type checker
    // rather than for a case that can occur.
    if (!dto) throw new NotFoundException('Proposal not found');
    return dto;
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

  // ── Member motions (GOV-01) ──────────────────────────────────────────────

  /**
   * Files a member motion. It enters at `gathering` with the proposer already
   * counted as its first co-signature, so `COSIGNATURE_THRESHOLD` means "the
   * proposer plus nine".
   *
   * The row and that founding signature are written in ONE transaction: a
   * motion whose own proposer is not on it would read as 0/10 and would let
   * the proposer withdraw a signature they never appear to have given, so
   * either both rows land or neither does.
   */
  async createMotion(
    dto: CreateGovernanceMotionDto,
    proposerId: string,
  ): Promise<GovernanceProposalDTO> {
    const gatheringMotionCount = await this.proposals.count({
      where: {
        proposedByMemberId: proposerId,
        status: GovernanceProposalStatus.Gathering,
      },
    });
    if (gatheringMotionCount >= MAX_GATHERING_MOTIONS_PER_MEMBER) {
      throw new HttpException(
        `You already have ${MAX_GATHERING_MOTIONS_PER_MEMBER} motions gathering ` +
          'co-signatures. Wait for one of them to be screened, rejected, or to ' +
          'lapse before filing another.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const gatheringClosesAt = new Date(
      Date.now() + GATHERING_WINDOW_DAYS * MILLISECONDS_PER_DAY,
    );

    const proposalId = await this.dataSource.transaction(async (manager) => {
      const saved = await manager.save(
        manager.create(GovernanceProposal, {
          type: GovernanceProposalType.MemberMotion,
          title: dto.title,
          description: dto.description,
          targetMemberId: null,
          status: GovernanceProposalStatus.Gathering,
          // `opensAt`/`closesAt` are NOT NULL on this table (they predate
          // motions, and every admin-opened proposal has a real window at
          // creation). A gathering motion has no voting window yet, so both
          // are seeded to `gatheringClosesAt` as a placeholder; the REAL
          // window is written by `approveMotion` when staff grant one. Nothing
          // reads them before that: `castVote` refuses any proposal that is
          // not `open`, and `resolveIfClosed` returns early on any status
          // other than `open`, so a placeholder that has already passed can
          // never open or resolve a ballot by itself.
          opensAt: gatheringClosesAt,
          closesAt: gatheringClosesAt,
          proposedByMemberId: proposerId,
          // The proposer is also the author of the row, so the staff audit
          // pointer names them too. The two stay separate columns because on
          // an admin-opened proposal only `createdByMemberId` is set.
          createdByMemberId: proposerId,
          // Frozen from the constant at filing time so a later change to the
          // platform-wide bar cannot move the target under a running drive.
          cosignatureThreshold: COSIGNATURE_THRESHOLD,
          gatheringClosesAt,
        }),
      );
      await manager.insert(GovernanceProposalCosignature, {
        proposalId: saved.id,
        memberId: proposerId,
      });
      return saved.id;
    });

    return this.getProposal(proposalId, proposerId);
  }

  /**
   * Adds the caller's co-signature to a gathering motion, and promotes the
   * motion to `screening` the moment the threshold is met.
   *
   * `hasReachedThreshold` is true only for the ONE request that actually made
   * the transition, which is what the controller keys the staff notification
   * off. It is derived from the conditional UPDATE's `affected` count rather
   * than from `count >= threshold`, so two co-signatures racing the tenth slot
   * cannot both claim it and notify staff twice.
   */
  async cosign(
    proposalId: string,
    memberId: string,
  ): Promise<CosignatureResult> {
    const proposal = await this.proposals.findOne({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.status !== GovernanceProposalStatus.Gathering) {
      throw new BadRequestException(
        'This proposal is not gathering co-signatures',
      );
    }
    if (
      proposal.gatheringClosesAt &&
      proposal.gatheringClosesAt.getTime() <= Date.now()
    ) {
      throw new BadRequestException(
        'The co-signature window for this motion has closed',
      );
    }

    // `ON CONFLICT DO NOTHING` on
    // `UQ_governance_proposal_cosignatures_proposal_member`, mirroring how
    // `castVote` uses `.orUpdate`: a second tap on an already-signed motion is
    // a silent no-op that reads back the same state, rather than a 409 or a
    // 500 on the unique violation. There is nothing to update — unlike a vote,
    // a co-signature carries no choice that could change.
    await this.cosignatures
      .createQueryBuilder()
      .insert()
      .into(GovernanceProposalCosignature)
      .values({ proposalId, memberId })
      .orIgnore()
      .execute();

    const cosignatureCount =
      (await this.cosignatureCountsFor([proposalId])).get(proposalId) ?? 0;
    const threshold = proposal.cosignatureThreshold ?? COSIGNATURE_THRESHOLD;

    let hasReachedThreshold = false;
    if (cosignatureCount >= threshold) {
      const promotion = await this.proposals.update(
        { id: proposalId, status: GovernanceProposalStatus.Gathering },
        { status: GovernanceProposalStatus.Screening },
      );
      hasReachedThreshold = (promotion.affected ?? 0) > 0;
    }

    return {
      proposal: await this.getProposal(proposalId, memberId),
      hasReachedThreshold,
    };
  }

  /**
   * Takes the caller's co-signature back off a motion that is still gathering.
   * A signature says "this deserves to be put to the community", and a member
   * is allowed to stop saying that while the drive is still running.
   *
   * The proposer is the one exception: their founding signature is what makes
   * the count "the proposer plus nine", and a motion standing on nine
   * strangers with its own author no longer behind it is not the thing staff
   * were asked to screen. They withdraw the motion itself instead.
   */
  async withdrawCosignature(
    proposalId: string,
    memberId: string,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.proposals.findOne({
      where: { id: proposalId },
    });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.status !== GovernanceProposalStatus.Gathering) {
      throw new BadRequestException(
        'This proposal is not gathering co-signatures',
      );
    }
    if (proposal.proposedByMemberId === memberId) {
      throw new ForbiddenException(
        'The member who filed a motion cannot withdraw their own founding signature',
      );
    }

    // Deleting a signature that was never there is a no-op, for the same
    // reason the insert is idempotent: the caller's intent ("I am not behind
    // this") is satisfied either way.
    await this.cosignatures.delete({ proposalId, memberId });

    return this.getProposal(proposalId, memberId);
  }

  // ── Admin screening (GOV-01) ─────────────────────────────────────────────

  /**
   * The staff screening queue. Defaults to `screening` — the motions actually
   * waiting on a decision — because that is the queue this endpoint exists to
   * serve; pass an explicit status to inspect any other shelf (`gathering` to
   * watch drives in flight, `rejected` to review past decisions).
   *
   * Bounded by `DEFAULT_LIST_LIMIT` and batched through `mapProposals`, same
   * as `listProposals`.
   */
  async listMotions(
    status: GovernanceProposalStatus | undefined,
    viewerId: string,
  ): Promise<GovernanceProposalDTO[]> {
    const rows = await this.proposals.find({
      where: {
        type: GovernanceProposalType.MemberMotion,
        status: status ?? GovernanceProposalStatus.Screening,
      },
      order: { createdAt: 'DESC' },
      take: DEFAULT_LIST_LIMIT,
    });
    return this.mapProposals(rows, viewerId);
  }

  /**
   * Staff put a screened motion to the community: it becomes an ordinary
   * `open` ballot with the window staff granted, and from here the existing
   * vote/`resolveIfClosed` path handles it with no motion-specific branch.
   *
   * Only `screening` can be approved. A motion still `gathering` has not yet
   * shown the support the process asks for, and approving one directly would
   * make the co-signature bar advisory.
   *
   * Sends nothing: the controller owns notifying the proposer.
   */
  async approveMotion(
    id: string,
    dto: ApproveGovernanceMotionDto,
    adminId: string,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.proposals.findOne({ where: { id } });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (proposal.status !== GovernanceProposalStatus.Screening) {
      throw new BadRequestException(
        'Only a motion awaiting screening can be approved',
      );
    }

    const opensAt = new Date(dto.opensAt);
    const closesAt = new Date(dto.closesAt);
    // The same check `createProposal` runs, for the same reason:
    // class-validator cannot compare two sibling fields cleanly.
    if (!(closesAt.getTime() > opensAt.getTime())) {
      throw new BadRequestException('closesAt must be after opensAt');
    }

    await this.proposals.update(id, {
      status: GovernanceProposalStatus.Open,
      opensAt,
      closesAt,
      screeningDecidedAt: new Date(),
      screeningDecidedByMemberId: adminId,
      screeningNote: dto.note ?? null,
    });

    return this.getProposal(id, adminId);
  }

  /**
   * Staff decline to put a motion to the community. Allowed from `gathering`
   * as well as `screening`: a motion that breaks the guidelines should not
   * have to run out its 30-day drive before it can be stopped.
   *
   * `screeningNote` is required by the DTO and recorded here, so the proposer
   * always gets a reason. Sends nothing: the controller owns notifying them.
   */
  async rejectMotion(
    id: string,
    dto: RejectGovernanceMotionDto,
    adminId: string,
  ): Promise<GovernanceProposalDTO> {
    const proposal = await this.proposals.findOne({ where: { id } });
    if (!proposal) throw new NotFoundException('Proposal not found');
    if (
      proposal.status !== GovernanceProposalStatus.Gathering &&
      proposal.status !== GovernanceProposalStatus.Screening
    ) {
      throw new BadRequestException(
        'Only a motion still gathering co-signatures or awaiting screening can be rejected',
      );
    }

    await this.proposals.update(id, {
      status: GovernanceProposalStatus.Rejected,
      screeningDecidedAt: new Date(),
      screeningDecidedByMemberId: adminId,
      screeningNote: dto.note,
    });

    return this.getProposal(id, adminId);
  }

  /**
   * Flips every `gathering` motion whose co-signature window has run out to
   * `lapsed`, returning how many were flipped.
   *
   * This one genuinely needs a sweep rather than the lazy on-read flip
   * `resolveIfClosed` uses: a motion that nobody is reading is exactly the
   * motion that lapses, so a read-triggered transition would leave the
   * forgotten ones sitting on the gathering shelf forever, still counting
   * against their proposer's `MAX_GATHERING_MOTIONS_PER_MEMBER` slots.
   *
   * Deliberately undecorated — `GovernanceMotionSweeperService` owns the
   * schedule, so this stays a plain, directly-callable, idempotent method that
   * a test or an admin action can invoke without going through cron. Batched
   * with a primary-key subselect + LIMIT (mirroring
   * `HousingListingExpirySweeperService`) so it never locks the whole table.
   */
  async lapseExpiredMotions(): Promise<number> {
    const now = new Date();
    const tableName = this.proposals.metadata.tableName;
    let totalLapsed = 0;

    for (let batch = 0; batch < LAPSE_MAX_BATCHES; batch += 1) {
      const result = await this.proposals
        .createQueryBuilder()
        .update(GovernanceProposal)
        .set({ status: GovernanceProposalStatus.Lapsed })
        .where(
          `id IN (SELECT id FROM "${tableName}" ` +
            `WHERE status = :gathering AND gathering_closes_at IS NOT NULL ` +
            `AND gathering_closes_at < :now LIMIT :limit)`,
          {
            gathering: GovernanceProposalStatus.Gathering,
            now,
            limit: LAPSE_BATCH_SIZE,
          },
        )
        .execute();
      const affected = result.affected ?? 0;
      totalLapsed += affected;
      if (affected < LAPSE_BATCH_SIZE) break;
    }

    return totalLapsed;
  }
}
