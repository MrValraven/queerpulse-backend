import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, In, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { Community } from '../communities/entities/community.entity';
import { Invite } from '../membership/entities/invite.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import {
  BanEvasionAssessmentDTO,
  BanEvasionSignalDTO,
  BanEvasionSignalKind,
  toBanEvasionAssessment,
} from './ban-evasion-response';
import {
  hashEmailIdentifier,
  hashOauthSubject,
  hashStatedName,
} from './ban-evasion.hash';
import {
  RemovalKind,
  RemovedAccountSignal,
} from './entities/removed-account-signal.entity';

/** What the listener hands over when a ban lands. */
export interface RecordRemovedAccountInput {
  userId: string;
  removalKind: RemovalKind;
  communityId: string | null;
  removedAt: Date;
}

/**
 * The correlation material for one subject being scored, whether that subject
 * is a join request from a stranger or an account already on the platform.
 * Assembling both into the same shape keeps one matcher instead of two that
 * could drift apart.
 */
export interface SubjectCorrelationMaterial {
  subjectId: string;
  /**
   * A removed-account row for this very account is not evidence about it. Set
   * when scoring an existing user; always null for a join request, which has no
   * account behind it.
   */
  ownRemovedUserId: string | null;
  emailHash: string | null;
  oauthSubjectHash: string | null;
  statedNameHash: string | null;
  /** The member whose invite brought this subject in, when there is one. */
  inviterUserId: string | null;
  /** The member named as a reference on this subject's join request. */
  referenceUserId: string | null;
}

/**
 * Ban-evasion signals: the answer to "does this application look like a member
 * who was already removed?", for a human reviewer to check.
 *
 * TWO SIDES.
 *
 * The write side (`recordRemovedAccount`) runs when a ban lands and stores the
 * removed account's correlation material as salted hashes plus its inviter
 * lineage. See `RemovedAccountSignal` for why that material survives account
 * erasure and why keeping it is compatible with erasing the person.
 *
 * The read side (`assessJoinRequests` / `assessUser`) scores a subject against
 * those rows and returns `{ tier, signals[] }`. It is READ ONLY and it is
 * ADVISORY. Nothing in this module blocks a sign-in, refuses a join request, or
 * changes anyone's standing: it hands a moderator a tier and a list of reasons,
 * each one about a specific removed account, and the moderator decides.
 *
 * It records nothing about what anyone DOES on the platform. No IP address, no
 * device fingerprint, no page view, no session. The only inputs are the
 * identifiers a person typed to get in and who vouched for them, both of which
 * the product already owns.
 */
@Injectable()
export class BanEvasionService {
  private readonly logger = new Logger(BanEvasionService.name);
  private hasWarnedAboutMissingPepper = false;

  constructor(
    @InjectRepository(RemovedAccountSignal)
    private readonly signals: Repository<RemovedAccountSignal>,
    @InjectRepository(PlatformJoinRequest)
    private readonly joinRequests: Repository<PlatformJoinRequest>,
    @InjectRepository(Invite) private readonly invites: Repository<Invite>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly config: ConfigService,
  ) {}

  /**
   * The configured pepper, or undefined. Warns ONCE per process when it is
   * missing so an operator sees it in the logs without a line per ban.
   */
  private pepper(): string | undefined {
    const configured = this.config.get<string>('banEvasion.pepper');
    if (!configured && !this.hasWarnedAboutMissingPepper) {
      this.hasWarnedAboutMissingPepper = true;
      this.logger.warn(
        'BAN_EVASION_PEPPER is not set. Sign-in identifiers will not be hashed and identifier signals are disabled. Inviter-lineage signals still work.',
      );
    }
    return configured;
  }

  /**
   * Record the correlation material of an account that has just been removed.
   *
   * Idempotent per (account, removal kind, community): banning the same person
   * from the same place twice refreshes the existing row instead of stacking
   * duplicates. A platform ban and a community ban on the same account are two
   * separate rows on purpose, because they are two different facts a reviewer
   * may want to see.
   *
   * Swallows nothing: the caller (the listener) decides what a failure means,
   * and it must never roll back the ban itself.
   */
  async recordRemovedAccount(input: RecordRemovedAccountInput): Promise<void> {
    const pepper = this.pepper();

    const user = await this.users.findOne({
      where: { id: input.userId },
      // `email` and `googleId` are `select: false` on the entity, so they are
      // named explicitly here. They are read, hashed, and dropped: neither
      // value is stored or logged.
      select: { id: true, email: true, googleId: true },
    });

    // The invite the removed account came in on carries the inviter; the join
    // request behind that invite carries what they stated when they applied.
    const invite = await this.invites.findOne({
      where: { acceptedBy: input.userId },
      order: { usedAt: 'DESC' },
    });
    const joinRequest = invite
      ? await this.joinRequests.findOne({ where: { inviteId: invite.id } })
      : null;

    const draft: Partial<RemovedAccountSignal> = {
      removedUserId: input.userId,
      removalKind: input.removalKind,
      communityId: input.communityId,
      removedAt: input.removedAt,
      signInEmailHash: hashEmailIdentifier(user?.email, pepper),
      oauthSubjectHash: hashOauthSubject(user?.googleId, pepper),
      intakeEmailHash: hashEmailIdentifier(
        joinRequest?.email ?? invite?.email ?? null,
        pepper,
      ),
      statedNameHash: hashStatedName(joinRequest?.name ?? null, pepper),
      inviterUserId: invite?.inviterId ?? null,
      referenceUserId: joinRequest?.referenceUserId ?? null,
    };

    const existing = await this.signals.findOne({
      where: {
        removedUserId: input.userId,
        removalKind: input.removalKind,
        ...(input.communityId ? { communityId: input.communityId } : {}),
      },
    });
    if (existing) {
      await this.signals.update({ id: existing.id }, draft);
      return;
    }
    await this.signals.save(this.signals.create(draft));
  }

  /**
   * Score a batch of join requests, one query for the signal rows however many
   * requests are in the batch. Returns one assessment per id that resolved to a
   * real join request, including `tier: 'none'` ones, so the caller can tell
   * "checked, nothing found" from "not checked".
   */
  async assessJoinRequests(
    joinRequestIds: string[],
  ): Promise<BanEvasionAssessmentDTO[]> {
    if (!joinRequestIds.length) return [];
    const pepper = this.pepper();

    const requests = await this.joinRequests.find({
      where: { id: In(joinRequestIds) },
    });
    if (!requests.length) return [];

    const subjects: SubjectCorrelationMaterial[] = requests.map((request) => ({
      subjectId: request.id,
      ownRemovedUserId: null,
      emailHash: hashEmailIdentifier(request.email, pepper),
      oauthSubjectHash: null,
      statedNameHash: hashStatedName(request.name, pepper),
      inviterUserId: null,
      referenceUserId: request.referenceUserId,
    }));

    return this.assessSubjects(subjects);
  }

  /**
   * Assemble the correlation material for a batch of accounts that already
   * exist, in a fixed number of queries however many accounts are asked about.
   *
   * PUBLIC because two readers need the SAME material: `assessUsers` below, and
   * `CommunityBanEvasionService`, which scores the identical subject against a
   * community-narrowed set of rows. Assembling it in one place is what stops a
   * moderator and a staff member forming two different ideas of who an
   * applicant is.
   *
   * A user id with no account row yields nothing, so the caller sees a shorter
   * array rather than a subject with every hash null.
   */
  async correlationMaterialForUsers(
    userIds: string[],
  ): Promise<SubjectCorrelationMaterial[]> {
    if (!userIds.length) return [];
    const pepper = this.pepper();

    const accounts = await this.users.find({
      where: { id: In(userIds) },
      // `email` and `googleId` are `select: false` on the entity, so they are
      // named explicitly. They are read, hashed, and dropped.
      select: { id: true, email: true, googleId: true },
    });
    if (!accounts.length) return [];

    const accountIds = accounts.map((account) => account.id);
    // The invite each account came in on carries the inviter. Ordered newest
    // first, so the first row seen for an account is the one to keep.
    const invites = await this.invites.find({
      where: { acceptedBy: In(accountIds) },
      order: { usedAt: 'DESC' },
    });
    const inviteByUserId = new Map<string, Invite>();
    for (const invite of invites) {
      const acceptedBy = invite.acceptedBy;
      if (!acceptedBy || inviteByUserId.has(acceptedBy)) continue;
      inviteByUserId.set(acceptedBy, invite);
    }

    const inviteIds = [...inviteByUserId.values()].map((invite) => invite.id);
    const platformRequests = inviteIds.length
      ? await this.joinRequests.find({ where: { inviteId: In(inviteIds) } })
      : [];
    const platformRequestByInviteId = new Map<string, PlatformJoinRequest>();
    for (const platformRequest of platformRequests) {
      if (!platformRequest.inviteId) continue;
      platformRequestByInviteId.set(platformRequest.inviteId, platformRequest);
    }

    return accounts.map((account) => {
      const invite = inviteByUserId.get(account.id) ?? null;
      const platformRequest = invite
        ? (platformRequestByInviteId.get(invite.id) ?? null)
        : null;
      return {
        subjectId: account.id,
        ownRemovedUserId: account.id,
        emailHash: hashEmailIdentifier(account.email, pepper),
        oauthSubjectHash: hashOauthSubject(account.googleId, pepper),
        statedNameHash: hashStatedName(platformRequest?.name ?? null, pepper),
        inviterUserId: invite?.inviterId ?? null,
        referenceUserId: platformRequest?.referenceUserId ?? null,
      };
    });
  }

  /**
   * Score a batch of accounts that already exist. Same signals as a join
   * request plus the OAuth subject, which a stranger's application cannot
   * carry.
   *
   * Batched because the staff escalation queue assesses a page of applicants at
   * once, and a per-row call would put an N+1 on the console this module exists
   * to serve.
   */
  async assessUsers(userIds: string[]): Promise<BanEvasionAssessmentDTO[]> {
    const subjects = await this.correlationMaterialForUsers(userIds);
    return this.assessSubjects(subjects);
  }

  /**
   * Score one account that already exists, for the case where someone got in
   * and staff are now asking whether this is a return.
   */
  async assessUser(userId: string): Promise<BanEvasionAssessmentDTO> {
    const [assessment] = await this.assessUsers([userId]);
    return assessment ?? toBanEvasionAssessment(userId, []);
  }

  /**
   * The shared matcher. Loads every signal row that could possibly match any
   * subject in the batch (one query), then pairs them up in memory and resolves
   * display context for the removed accounts and communities involved in two
   * more batched lookups.
   */
  private async assessSubjects(
    subjects: SubjectCorrelationMaterial[],
  ): Promise<BanEvasionAssessmentDTO[]> {
    const emailHashes = unique(subjects.map((subject) => subject.emailHash));
    const oauthHashes = unique(
      subjects.map((subject) => subject.oauthSubjectHash),
    );
    const nameHashes = unique(
      subjects.map((subject) => subject.statedNameHash),
    );
    const lineageUserIds = unique([
      ...subjects.map((subject) => subject.inviterUserId),
      ...subjects.map((subject) => subject.referenceUserId),
    ]);

    const candidateRows = await this.findCandidateSignals(
      emailHashes,
      oauthHashes,
      nameHashes,
      lineageUserIds,
    );

    // Display context for every removed account and community mentioned, two
    // batched lookups for the whole batch rather than one per signal.
    const removedUserIds = unique(
      candidateRows.map((row) => row.removedUserId),
    );
    const communityIds = unique(candidateRows.map((row) => row.communityId));
    const [refsByUserId, communityNameById] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(removedUserIds),
      this.communityNames(communityIds),
    ]);

    return subjects.map((subject) => {
      const signals: BanEvasionSignalDTO[] = [];
      for (const row of candidateRows) {
        if (
          subject.ownRemovedUserId &&
          row.removedUserId === subject.ownRemovedUserId
        ) {
          continue;
        }
        for (const kind of matchKinds(subject, row)) {
          signals.push(
            this.toSignalDTO(kind, row, refsByUserId, communityNameById),
          );
        }
      }
      return toBanEvasionAssessment(subject.subjectId, signals);
    });
  }

  /**
   * Every signal row that could match anything in this batch. Each OR arm is an
   * indexed equality, and empty arms are left out entirely so an all-null batch
   * (no pepper configured, no lineage) returns nothing rather than scanning.
   */
  private async findCandidateSignals(
    emailHashes: string[],
    oauthHashes: string[],
    nameHashes: string[],
    lineageUserIds: string[],
  ): Promise<RemovedAccountSignal[]> {
    const hasAnyCriterion =
      emailHashes.length > 0 ||
      oauthHashes.length > 0 ||
      nameHashes.length > 0 ||
      lineageUserIds.length > 0;
    if (!hasAnyCriterion) return [];

    const queryBuilder = this.signals.createQueryBuilder('signal');
    queryBuilder.where(
      new Brackets((where) => {
        let hasArm = false;
        const arm = (condition: string, parameters: object) => {
          if (hasArm) where.orWhere(condition, parameters);
          else where.where(condition, parameters);
          hasArm = true;
        };
        if (emailHashes.length) {
          arm('signal.signInEmailHash IN (:...emailHashes)', { emailHashes });
          arm('signal.intakeEmailHash IN (:...intakeHashes)', {
            intakeHashes: emailHashes,
          });
        }
        if (oauthHashes.length) {
          arm('signal.oauthSubjectHash IN (:...oauthHashes)', { oauthHashes });
        }
        if (nameHashes.length) {
          arm('signal.statedNameHash IN (:...nameHashes)', { nameHashes });
        }
        if (lineageUserIds.length) {
          arm('signal.removedUserId IN (:...lineageUserIds)', {
            lineageUserIds,
          });
          arm('signal.inviterUserId IN (:...inviterLineageIds)', {
            inviterLineageIds: lineageUserIds,
          });
          arm('signal.referenceUserId IN (:...referenceLineageIds)', {
            referenceLineageIds: lineageUserIds,
          });
        }
      }),
    );
    return queryBuilder.orderBy('signal.removedAt', 'DESC').getMany();
  }

  private toSignalDTO(
    kind: BanEvasionSignalKind,
    row: RemovedAccountSignal,
    refsByUserId: Map<string, MemberRef>,
    communityNameById: Map<string, string>,
  ): BanEvasionSignalDTO {
    const ref = row.removedUserId
      ? (refsByUserId.get(row.removedUserId) ?? null)
      : null;
    return {
      kind,
      removalKind: row.removalKind,
      removedAt: row.removedAt.toISOString(),
      removedAccountName: ref
        ? `${ref.firstName} ${ref.lastName}`.trim()
        : null,
      removedAccountSlug: ref ? ref.slug : null,
      communityName: row.communityId
        ? (communityNameById.get(row.communityId) ?? null)
        : null,
    };
  }

  /** communityId -> name, for the communities named in this batch. */
  private async communityNames(
    communityIds: string[],
  ): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    if (!communityIds.length) return names;
    const rows = await this.communities.find({
      where: { id: In(communityIds) },
      select: { id: true, name: true },
    });
    for (const row of rows) names.set(row.id, row.name);
    return names;
  }
}

/** Deduped, non-null values, so an `IN (:...)` never receives an empty list. */
function unique(values: (string | null)[]): string[] {
  return [...new Set(values.filter((value): value is string => !!value))];
}

/**
 * Which signals this one removed-account row raises against this one subject.
 *
 * Every branch is an exact match on material the product already holds. Nothing
 * here is a similarity score or a guess about who someone is.
 *
 * Exported so `CommunityBanEvasionService` can run the SAME matcher over a
 * narrowed set of rows. There is one matcher on purpose: a second copy scoped
 * to a community would drift from this one, and a moderator and a staff member
 * looking at the same applicant would then be reading two different answers.
 */
export function matchKinds(
  subject: SubjectCorrelationMaterial,
  row: RemovedAccountSignal,
): BanEvasionSignalKind[] {
  const kinds: BanEvasionSignalKind[] = [];

  const isIdentifierMatch =
    (!!subject.emailHash && subject.emailHash === row.signInEmailHash) ||
    (!!subject.oauthSubjectHash &&
      subject.oauthSubjectHash === row.oauthSubjectHash);
  if (isIdentifierMatch) kinds.push('sign_in_identifier_match');

  if (!!subject.emailHash && subject.emailHash === row.intakeEmailHash) {
    kinds.push('intake_contact_match');
  }
  if (
    !!subject.statedNameHash &&
    subject.statedNameHash === row.statedNameHash
  ) {
    kinds.push('stated_details_match');
  }

  if (subject.inviterUserId) {
    if (subject.inviterUserId === row.removedUserId)
      kinds.push('inviter_removed');
    else if (subject.inviterUserId === row.inviterUserId) {
      kinds.push('inviter_of_removed_account');
    }
  }
  if (subject.referenceUserId) {
    if (subject.referenceUserId === row.removedUserId) {
      kinds.push('reference_removed');
    } else if (
      subject.referenceUserId === row.inviterUserId ||
      subject.referenceUserId === row.referenceUserId
    ) {
      kinds.push('reference_of_removed_account');
    }
  }

  return kinds;
}
