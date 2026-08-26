import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import {
  AccessTier,
  CommunityType,
} from '../communities/entities/community.entity';
import {
  CommunitiesService,
  CreateCommunityInput,
} from '../communities/communities.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { Profile } from '../users/entities/profile.entity';
import {
  ReadingGroupProposal,
  ReadingGroupProposalFormat,
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
 * The community a newly approved reading group is created with. A reading
 * group is a small standing group around one book, so the shape is fixed here
 * rather than asked of the reviewing admin: the member already told us the
 * book, why, the meeting format and the size cap, and re-asking a moderator to
 * retype all four into a community form is exactly the friction that left this
 * queue unwired.
 *
 * `Request` access, not `Public`: the proposal carries a hard size cap
 * (`maxPeople` is 4, 6 or 8), so the owner has to be able to hold the group at
 * the size they asked for. `isPubliclyListed` stays off — a signed-out teaser
 * is the owner's call to make later, never the platform's on their behalf.
 */
const READING_GROUP_COMMUNITY_TYPE = CommunityType.Arts;
const READING_GROUP_ACCESS_TIER = AccessTier.Request;
const READING_GROUP_FEATURES = ['discussion', 'events', 'roster'];
/** Lisbon is the only city. */
const READING_GROUP_CITY = 'Lisbon';

/**
 * Read model behind the admin dashboard's reading-group-proposal oversight
 * surface: every "Start your own group" a member has submitted, newest first,
 * optionally filtered by format and by decision state, paginated.
 *
 * Every row is hand-mapped to `AdminReadingGroupProposalDTO` (never a raw
 * entity), and the proposing members are resolved in ONE batched profile lookup
 * across the whole page — never one query per row — mirroring
 * `AdminInvitesService`.
 *
 * The three decisions are NOT symmetric (LOC-19):
 *  - `approve` CREATES a real community owned by the proposer and tells them
 *    where it is. Before this it stamped four columns and saved, so approving
 *    a proposal changed a varchar and nothing else ever happened.
 *  - `decline` requires a reason and tells the proposer that reason.
 *  - `archive` is the only silent one: it is "filed away without a verdict",
 *    so there is no outcome to notify a member about.
 */
@Injectable()
export class AdminReadingGroupProposalsService {
  private readonly logger = new Logger(AdminReadingGroupProposalsService.name);

  constructor(
    @InjectRepository(ReadingGroupProposal)
    private readonly proposals: Repository<ReadingGroupProposal>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    // The real community create path, reused rather than reimplemented: slug
    // allocation, the `communities_ref_seq` ref, the owner's roster row, the
    // `COMMUNITY_MEMBER_JOINED` emit and the create transaction's retry loop
    // all live there and must not be duplicated here.
    private readonly communities: CommunitiesService,
    private readonly notifications: NotificationsService,
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

    if (query.status) {
      proposalQueryBuilder.andWhere('proposal.status = :status', {
        status: query.status,
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
   * Approve a proposal: create the member's reading group as a real community
   * they own, record the decision, and tell them where it is.
   *
   * IDEMPOTENT. A proposal that already carries a `createdCommunitySlug` is
   * returned unchanged — no second community, no second notification — so a
   * double-clicked approve, a retried request or a second moderator working
   * the same queue cannot mint duplicates. The slug column is the guard rather
   * than the `status`, because `status` alone could not distinguish "approved
   * and built" from a row approved before approval built anything.
   *
   * Ordering is deliberate: the community is created FIRST and the proposal is
   * only stamped once that has succeeded. A failed create therefore leaves the
   * proposal `pending` and re-approvable, instead of leaving it "approved"
   * pointing at nothing.
   */
  async approve(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    const proposal = await this.loadOr404(id);

    if (proposal.createdCommunitySlug) {
      return this.toDTO(proposal);
    }

    const community = await this.communities.create(
      proposal.memberId,
      this.communityInputFor(proposal),
    );

    proposal.status = ReadingGroupProposalStatus.Approved;
    proposal.decidedAt = new Date();
    proposal.decidedBy = adminUserId;
    proposal.decisionNote = AdminReadingGroupProposalsService.trimToNull(note);
    proposal.createdCommunitySlug = community.slug;
    const saved = await this.proposals.save(proposal);

    await this.notifyDecided(saved, {
      decision: 'approved',
      communitySlug: community.slug,
      communityName: community.name,
    });

    return this.toDTO(saved);
  }

  /**
   * Decline a proposal with a REQUIRED reason, and tell the proposer that
   * reason. The reason is stored in the same `decisionNote` column the other
   * two decisions use — one audit field, not a second parallel one.
   */
  async decline(
    id: string,
    adminUserId: string,
    reason: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    const trimmedReason = AdminReadingGroupProposalsService.trimToNull(reason);
    if (!trimmedReason) {
      throw new BadRequestException(
        'A declined reading-group proposal needs a reason.',
      );
    }

    const proposal = await this.loadOr404(id);
    proposal.status = ReadingGroupProposalStatus.Declined;
    proposal.decidedAt = new Date();
    proposal.decidedBy = adminUserId;
    proposal.decisionNote = trimmedReason;
    const saved = await this.proposals.save(proposal);

    await this.notifyDecided(saved, {
      decision: 'declined',
      reason: trimmedReason,
    });

    return this.toDTO(saved);
  }

  /**
   * Archive a proposal: filed away without an accept/reject verdict, and the
   * ONE decision that stays silent. There is no outcome to report, and telling
   * a member "your proposal was archived" would be a notification whose only
   * content is that nobody decided.
   */
  async archive(
    id: string,
    adminUserId: string,
    note?: string,
  ): Promise<AdminReadingGroupProposalDTO> {
    const proposal = await this.loadOr404(id);
    proposal.status = ReadingGroupProposalStatus.Archived;
    proposal.decidedAt = new Date();
    proposal.decidedBy = adminUserId;
    proposal.decisionNote = AdminReadingGroupProposalsService.trimToNull(note);
    const saved = await this.proposals.save(proposal);
    return this.toDTO(saved);
  }

  // --- internals ------------------------------------------------------------

  private async loadOr404(id: string): Promise<ReadingGroupProposal> {
    const proposal = await this.proposals.findOne({ where: { id } });
    if (!proposal) {
      throw new NotFoundException('Reading-group proposal not found.');
    }
    return proposal;
  }

  /** Hand-map to the DTO with the proposer resolved. Never a raw entity. */
  private async toDTO(
    proposal: ReadingGroupProposal,
  ): Promise<AdminReadingGroupProposalDTO> {
    const memberLookup = new MemberLookup(this.profiles);
    const refsByUserId = await memberLookup.byUserIds([proposal.memberId]);
    return toAdminReadingGroupProposalDTO(
      proposal,
      refsByUserId.get(proposal.memberId) ?? null,
    );
  }

  /**
   * The proposal, translated into the community that IS the reading group. The
   * member's own words carry across verbatim wherever they fit: the book title
   * becomes the community name and the desired handle, "why this book?"
   * becomes the purpose, and the format and size cap become the tags, the
   * online flag and the who-it-is-for line.
   */
  private communityInputFor(
    proposal: ReadingGroupProposal,
  ): CreateCommunityInput {
    const book = proposal.book.trim();
    const why = proposal.why?.trim() ?? '';
    const isOnline = proposal.format !== ReadingGroupProposalFormat.InPerson;
    const meetsInPerson = proposal.format !== ReadingGroupProposalFormat.Online;

    const tags = ['book-club'];
    if (meetsInPerson) tags.push('in-person-meetups');
    if (isOnline) tags.push('virtual-online');

    return {
      // `book` is capped at 200 by the create DTO and the column, the same cap
      // `CreateCommunityDto.name` carries, so it transfers whole.
      name: book,
      handle: book,
      tagline: `A reading group for ${book}.`.slice(0, 200),
      purpose: why || `A reading group for ${book}.`,
      whoFor: `Members who want to read ${book} together, in a group of up to ${proposal.maxPeople}.`,
      type: READING_GROUP_COMMUNITY_TYPE,
      accessTier: READING_GROUP_ACCESS_TIER,
      rosterVisible: true,
      features: READING_GROUP_FEATURES,
      // No house rules are invented on the owner's behalf: the group's rules
      // are theirs to write, and a rule nobody agreed to is worse than none.
      rules: [],
      tags,
      isOnline,
      city: meetsInPerson ? READING_GROUP_CITY : null,
      isPubliclyListed: false,
    };
  }

  /**
   * Best-effort "here is what happened to your proposal" to the proposer,
   * in-app plus push (never email — QueerPulse sends none). Never throws: the
   * decision has already committed by the time this runs, and a notification
   * failure must not turn a completed approval into a 500 the admin retries.
   */
  private async notifyDecided(
    proposal: ReadingGroupProposal,
    outcome: {
      decision: 'approved' | 'declined';
      communitySlug?: string;
      communityName?: string;
      reason?: string;
    },
  ): Promise<void> {
    try {
      await this.notifications.create(
        proposal.memberId,
        NotificationType.ReadingGroupProposalDecided,
        {
          // `source` + `communitySlug` are the structural deep-link pair the
          // client's `sourceHrefFromPayload` already understands, so an
          // approval lands the proposer on their new community with no new
          // routing code.
          source: 'community',
          decision: outcome.decision,
          book: proposal.book,
          ...(outcome.communitySlug
            ? { communitySlug: outcome.communitySlug }
            : {}),
          ...(outcome.communityName
            ? { communityName: outcome.communityName }
            : {}),
          ...(outcome.reason ? { reason: outcome.reason } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to notify proposer of reading-group proposal ${proposal.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Empty or whitespace-only free text stores as NULL, never as a blank. */
  private static trimToNull(value: string | undefined | null): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  }
}
