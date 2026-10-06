import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PolicyAcceptance } from '../consent/entities/policy-acceptance.entity';
import { FlatmateProfile } from '../flatmate-profiles/entities/flatmate-profile.entity';
import { GroupJoinRequest } from '../housing-groups/entities/group-join-request.entity';
import {
  HousingViewing,
  HousingViewingParty,
  HousingViewingStatus,
} from '../housing-viewings/entities/housing-viewing.entity';
import { CoopJoinRequest } from '../housing/entities/coop-join-request.entity';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';
import { Block } from '../social/entities/block.entity';
import { DataExportContribution } from './data-export-contributor';

/**
 * ENG-495: member-held tables the Art. 20 archive used to skip. The Housing
 * request checkbox promised "flatmate profile, viewing requests" while the
 * archive carried the member's housing listings alone, and the blocks a member
 * placed, the reports they filed and their policy acceptances had no key at
 * all.
 *
 * Each class writes one archive key and rides on an existing request category
 * (`housing`, `connections`, `consent`), the way `messages` carries both
 * `messages` and `reportedConversations`. `reports` is the one new category.
 * Registered through `NEW_DOMAIN_EXPORT_CONTRIBUTORS` in
 * `data-export-contributors.ts`. Every row belongs to the member, dates travel
 * as ISO strings and lists are ordered by `createdAt` ASC.
 */

/** A nullable timestamp as an ISO string, or null. */
function isoOrNull(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

/**
 * `housing` -> `flatmateProfile`: the member's own flatmate profile, or null.
 *
 * Every column travels, the GDPR Art. 9 special-category ones included
 * (pronouns, gender identity, safe-space needs, the identity-household
 * prompts): the member wrote them, so they are theirs to take. The consent
 * stamp and the visibility choice travel too, so the archive records who the
 * member let see those fields and since when.
 */
@Injectable()
export class FlatmateProfileExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'flatmateProfile';

  constructor(
    @InjectRepository(FlatmateProfile)
    private readonly flatmateProfiles: Repository<FlatmateProfile>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const profile = await this.flatmateProfiles.findOne({
      where: { ownerId: userId },
    });
    if (!profile) return null;
    return {
      id: profile.id,
      slug: profile.slug,
      type: profile.type,
      pronouns: profile.pronouns,
      neighbourhood: profile.neighbourhood,
      budgetEuros: profile.budgetEuros,
      moveInFrom: profile.moveInFrom,
      flexibleTiming: profile.flexibleTiming,
      about: profile.about,
      lifestyleTags: profile.lifestyleTags,
      genderIdentity: profile.genderIdentity,
      safeSpaceNeeds: profile.safeSpaceNeeds,
      householdNorms: profile.householdNorms,
      identityHousehold: profile.identityHousehold,
      identityVisibility: profile.identityVisibility,
      specialCategoryConsentAt: isoOrNull(profile.specialCategoryConsentAt),
      createdAt: profile.createdAt.toISOString(),
      updatedAt: profile.updatedAt.toISOString(),
    };
  }
}

/**
 * Who wrote a viewing's `responseNote`. Only a counter-proposal and a decline
 * write it (`HousingViewingsService.propose` / `decline`), and neither accept
 * nor cancel touches it. A proposal also moves `proposedBy` to its author,
 * while a decline leaves `proposedBy` on the party being turned down. So a
 * declined viewing's note belongs to the party opposite `proposedBy`, and any
 * other viewing's note belongs to `proposedBy`.
 */
function responseNoteAuthorOf(viewing: HousingViewing): HousingViewingParty {
  if (viewing.status !== HousingViewingStatus.Declined) {
    return viewing.proposedBy;
  }
  return viewing.proposedBy === HousingViewingParty.Requester
    ? HousingViewingParty.Lister
    : HousingViewingParty.Requester;
}

/**
 * `housing` -> `viewings`: the viewings the member asked for (`role:
 * 'requester'`) and the viewings requested on housing they list (`role:
 * 'owner'`), merged in one `createdAt` ASC list.
 *
 * Each row carries only the member's own words, as the `messages` export
 * does. A requester row keeps the member's opening note. An owner row names
 * the requester by id alone, and the requester's opening note stays in their
 * archive. On both, the reply note appears only when the member wrote it
 * (`responseNoteAuthorOf`); a note the other party wrote is null.
 */
@Injectable()
export class HousingViewingsExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'viewings';

  constructor(
    @InjectRepository(HousingViewing)
    private readonly housingViewings: Repository<HousingViewing>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.housingViewings.find({
      where: [{ requesterId: userId }, { listerId: userId }],
      order: { createdAt: 'ASC' },
    });
    return rows.map((viewing) => {
      const shared = {
        id: viewing.id,
        listingId: viewing.listingId,
        mode: viewing.mode,
        status: viewing.status,
        proposedBy: viewing.proposedBy,
        proposedSlots: viewing.proposedSlots.map((slot) =>
          new Date(slot).toISOString(),
        ),
        acceptedSlot: viewing.acceptedSlot
          ? new Date(viewing.acceptedSlot).toISOString()
          : null,
        createdAt: viewing.createdAt.toISOString(),
        updatedAt: viewing.updatedAt.toISOString(),
      };
      const isRequester = viewing.requesterId === userId;
      const isResponseNoteOwn =
        responseNoteAuthorOf(viewing) ===
        (isRequester
          ? HousingViewingParty.Requester
          : HousingViewingParty.Lister);
      if (isRequester) {
        return {
          ...shared,
          role: 'requester' as const,
          note: viewing.note,
          responseNote: isResponseNoteOwn ? viewing.responseNote : null,
        };
      }
      return {
        ...shared,
        role: 'owner' as const,
        requesterId: viewing.requesterId,
        responseNote: isResponseNoteOwn ? viewing.responseNote : null,
      };
    });
  }
}

/**
 * `housing` -> `groupJoinRequests`: the requests the member made to join an
 * access-gated housing group, with the name they gave, their own words on
 * their relationship to the community, their screening answers (each with the
 * question as it was asked) and where the request stands.
 */
@Injectable()
export class GroupJoinRequestsExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'groupJoinRequests';

  constructor(
    @InjectRepository(GroupJoinRequest)
    private readonly groupJoinRequests: Repository<GroupJoinRequest>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.groupJoinRequests.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((request) => ({
      id: request.id,
      groupId: request.groupId,
      name: request.name,
      relationship: request.relationship,
      answers: request.answers,
      note: request.note,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    }));
  }
}

/**
 * `housing` -> `coopJoinRequests`: the requests the member made to join a
 * housing co-op, with the name and household size they gave, their note and
 * where the request stands.
 */
@Injectable()
export class CoopJoinRequestsExportContributor implements DataExportContribution {
  readonly category = 'housing';
  readonly archiveKey = 'coopJoinRequests';

  constructor(
    @InjectRepository(CoopJoinRequest)
    private readonly coopJoinRequests: Repository<CoopJoinRequest>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.coopJoinRequests.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((request) => ({
      id: request.id,
      coopId: request.coopId,
      name: request.name,
      householdSize: request.householdSize,
      note: request.note,
      status: request.status,
      createdAt: request.createdAt.toISOString(),
    }));
  }
}

/**
 * `connections` -> `blocks`: the blocks the member placed. Two tables hold
 * them: `blocks` for another member (`type: 'member'`) and `identity_blocks`
 * for a business, persona or company (`type: 'identity'`). Both are read by
 * the blocker column alone, so a block somebody else placed on this member
 * stays in that person's archive. The two lists merge into one `createdAt`
 * ASC list.
 */
@Injectable()
export class BlocksExportContributor implements DataExportContribution {
  readonly category = 'connections';
  readonly archiveKey = 'blocks';

  constructor(
    @InjectRepository(Block)
    private readonly blocks: Repository<Block>,
    @InjectRepository(IdentityBlock)
    private readonly identityBlocks: Repository<IdentityBlock>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const [memberBlocks, identityBlocks] = await Promise.all([
      this.blocks.find({
        where: { blockerId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.identityBlocks.find({
        where: { blockerUserId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    const merged = [
      // PRD-423: a block placed from inside a matched Go together chat
      // exports as the Blocked list shows it, naming nobody: the member only
      // ever knew that person by first name, so no user id rides along.
      ...memberBlocks.map((block) => ({
        type: 'member' as const,
        id: block.id,
        ...(block.matchedConversationId
          ? { isMatchedChatBlock: true as const }
          : { blockedUserId: block.blockedId }),
        reason: block.reason,
        createdAt: block.createdAt,
      })),
      // A block carried across a persona going unlinked (ENG-447) exports
      // as the member's Blocked list shows it: the retired identity's id and
      // the named persona's name.
      ...identityBlocks.map((block) => ({
        type: 'identity' as const,
        id: block.id,
        identityId: block.identityId ?? block.retiredIdentityId,
        ...(block.blockedNameSnapshot
          ? { blockedName: block.blockedNameSnapshot }
          : {}),
        createdAt: block.createdAt,
      })),
    ];
    return merged
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .map((block) => ({ ...block, createdAt: block.createdAt.toISOString() }));
  }
}

/** The evidence types the reporter attached. Every other entry is a server
 * snapshot of the reported thing (`report-evidence.ts`), which holds somebody
 * else's content. */
const REPORTER_EVIDENCE_TYPES: ReadonlySet<string> = new Set([
  'url',
  'screenshot',
]);

/** The evidence entries the reporter attached themselves. */
function reporterEvidenceOf(evidence: unknown[] | null): unknown[] {
  return (evidence ?? []).filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      REPORTER_EVIDENCE_TYPES.has(String((entry as { type?: unknown }).type)),
  );
}

/**
 * `reports` -> `reportsFiled`: the reports the member filed, with what they
 * reported, the reason they picked, their own words, the evidence they
 * attached, whether they filed anonymously, and where each report stands.
 *
 * The moderation side stays out: severity, SLA, assignee, the resolving
 * moderator, the action taken and the resolution note are the moderators'
 * working record about somebody else. So do the server snapshots in
 * `evidence`, which copy the reported person's content. `resolvedAt` travels
 * as the date the member's report was closed.
 */
@Injectable()
export class ReportsFiledExportContributor implements DataExportContribution {
  readonly category = 'reports';
  readonly archiveKey = 'reportsFiled';

  constructor(
    @InjectRepository(Report)
    private readonly reports: Repository<Report>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.reports.find({
      where: { reporterId: userId },
      order: { createdAt: 'ASC' },
    });
    const matchedChatMemberIds = await this.matchedChatMemberIds(userId, rows);
    return rows.map((report) => ({
      id: report.id,
      subjectType: report.subjectType,
      // PRD-423: a member the reporter shares a matched Go together chat
      // with is someone they may only know by first name (a report filed by
      // member key, or from the group sheet), so the archive names no user
      // id for them.
      ...(report.subjectType === ReportSubjectType.Member &&
      matchedChatMemberIds.has(report.subjectId)
        ? { isMatchedChatReport: true as const }
        : { subjectId: report.subjectId }),
      reasonCode: report.reasonCode,
      detail: report.detail,
      evidence: reporterEvidenceOf(report.evidence),
      anonymous: report.anonymous,
      status: report.status,
      createdAt: report.createdAt.toISOString(),
      resolvedAt: isoOrNull(report.resolvedAt),
    }));
  }

  /** PRD-423: which of the member subjects of `rows` hold a seat in a
   *  matched Go together chat the reporter holds one in too. One query, and
   *  none when the archive reports no member. */
  private async matchedChatMemberIds(
    userId: string,
    rows: Report[],
  ): Promise<Set<string>> {
    const memberSubjectIds = [
      ...new Set(
        rows
          .filter((report) => report.subjectType === ReportSubjectType.Member)
          .map((report) => report.subjectId),
      ),
    ];
    if (!memberSubjectIds.length) return new Set();
    const shared: Array<{ userId: string }> = await this.reports.manager.query(
      `SELECT DISTINCT "other_seat"."user_id"::text AS "userId"
         FROM "conversation_participants" "own_seat"
         JOIN "conversation_participants" "other_seat"
           ON "other_seat"."conversation_id" = "own_seat"."conversation_id"
         JOIN "conversations" "matched_chat"
           ON "matched_chat"."id" = "own_seat"."conversation_id"
        WHERE "own_seat"."user_id" = $1
          AND "other_seat"."user_id"::text = ANY($2)
          AND ("matched_chat"."is_go_together_chat"
            OR "matched_chat"."event_match_group_id" IS NOT NULL)`,
      [userId, memberSubjectIds],
    );
    return new Set(shared.map((row) => row.userId));
  }
}

/**
 * `consent` -> `policyAcceptances`: every revision of the Terms and Community
 * Guidelines the member agreed to, what they had on file before each one, and
 * how it was asked (`policy_acceptance`, append-only).
 */
@Injectable()
export class PolicyAcceptancesExportContributor implements DataExportContribution {
  readonly category = 'consent';
  readonly archiveKey = 'policyAcceptances';

  constructor(
    @InjectRepository(PolicyAcceptance)
    private readonly policyAcceptances: Repository<PolicyAcceptance>,
  ) {}

  async buildContribution(userId: string): Promise<unknown> {
    const rows = await this.policyAcceptances.find({
      where: { userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((acceptance) => ({
      id: acceptance.id,
      termsVersion: acceptance.termsVersion,
      guidelinesVersion: acceptance.guidelinesVersion,
      previousTermsVersion: acceptance.previousTermsVersion,
      previousGuidelinesVersion: acceptance.previousGuidelinesVersion,
      source: acceptance.source,
      createdAt: acceptance.createdAt.toISOString(),
    }));
  }
}
