import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { escapeLikeTerm } from '../common/like-escape';
import { PRIVATE_PARAMETERS_COMMENT } from '../database/private-parameters-logger';
import { MediaCropService } from '../media-crops/media-crops.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  foldedHaystack,
  foldedSearchTerm,
  PROFILE_NAME_SEARCH_COLUMNS,
} from '../search/search-text';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { LeadAssignee } from './entities/lead-assignee.entity';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { TOUCH_LEAD_SQL } from './lead-entries.service';
import { normalizeSearchTerm } from './lead-input';
import {
  type LeadCaller,
  type LeadDTO,
  type LeadStaffProfileRow,
  type LeadStaffSummaryDTO,
  toLeadStaffSummary,
} from './lead-response';
import {
  LEAD_STAFF_ELIGIBLE_SQL,
  leadStaffEligibility,
} from './lead-staff-eligibility';
import {
  LEAD_MAX_ASSIGNEES,
  LEAD_STAFF_PREVIEW_LIMIT,
  LEAD_STAFF_SEARCH_LIMIT,
  leadError,
} from './leads.constants';
import { LeadsService, LOCK_LEADS_SQL } from './leads.service';

/** The staff picker's folded name haystack over `"profile"`: first name,
 *  last name and slug, the expression `IDX_profiles_name_search_folded_trgm`
 *  indexes. */
export const LEAD_STAFF_SEARCH_HAYSTACK = foldedHaystack(
  'profile',
  PROFILE_NAME_SEARCH_COLUMNS,
);

/** `:term` the escaped `%...%` pattern. A typed picker query matches the
 *  folded haystack, wildcards in the typed text matched literally. */
export const LEAD_STAFF_SEARCH_SQL = `${LEAD_STAFF_SEARCH_HAYSTACK} LIKE ${foldedSearchTerm('term')} ESCAPE '\\'`;

/** `:callerId` the caller. Sorts the caller ahead of everyone else in the
 *  blank picker preview. */
export const LEAD_STAFF_CALLER_FIRST_SQL =
  'CASE WHEN "staff"."id" = CAST(:callerId AS uuid) THEN 0 ELSE 1 END';

/** The first-name sort of every picker query. */
const LEAD_STAFF_FIRST_NAME_ORDER = 'lower("profile"."first_name")';

/** The last-name sort after the first name. */
const LEAD_STAFF_LAST_NAME_ORDER = 'lower("profile"."last_name")';

/** The last sort, so people with equal names keep a stable order. */
const LEAD_STAFF_ID_ORDER = 'staff.id';

/** The raw columns one picker row answers: the five the summary needs plus
 *  the photo flag that gates its avatar. */
interface LeadStaffPickerRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
}

/** The `userId` property of an assign body, or undefined when the body is
 *  no object. */
function assigneeIdOf(requestBody: unknown): unknown {
  if (typeof requestBody !== 'object' || requestBody === null) {
    return undefined;
  }
  return (requestBody as { userId?: unknown }).userId;
}

/** The profile columns of a picker row, read field by field so a stray
 *  column never reaches the summary. */
function profileRowOf(row: LeadStaffPickerRow): LeadStaffProfileRow {
  return {
    slug: row.slug,
    firstName: row.first_name,
    lastName: row.last_name,
    avatarUrl: row.avatar_url,
    photoVisible: row.photo_visible,
  };
}

/**
 * Leads: who is in charge of a lead. The staff picker (`searchStaff`), the
 * assign route (`assign`) and the unassign route (`unassign`). The
 * controller's guards admit only the Admin tier and holders of the Leads
 * grant; this service trusts that gate and checks the rest in the
 * contract's order.
 *
 * Assign: malformed lead id (`LEAD_NOT_FOUND`), body `userId` missing or no
 * uuid (400 `LEAD_ASSIGNEE_NOT_FOUND`), then inside one transaction the
 * leads table lock and the lead row lock (`LEAD_NOT_FOUND`), an existing
 * assignment (answers the lead unchanged, with no eligibility check), the
 * person's eligibility (`LEAD_ASSIGNEE_NOT_FOUND`, `LEAD_ASSIGNEE_NOT_STAFF`
 * with `reason`), then the cap (`LEAD_TOO_MANY_ASSIGNEES`). The table lock
 * serialises every assign, so two assigns can never both pass the cap.
 *
 * Unassign: malformed lead id (`LEAD_NOT_FOUND`), malformed user id
 * (`LEAD_ASSIGNEE_NOT_FOUND`), then the same two locks (`LEAD_NOT_FOUND`).
 * A person who is not in charge answers the lead unchanged.
 *
 * Both writes are idempotent. A write that changes something records an
 * entry on the lead and stamps its `updated_at`; it writes no audit row,
 * since the entry log is the record. A new assignment of someone other than
 * the caller sends `lead_assigned` after the commit, with ids only and no
 * `actorId` argument, so a mute between two staff members never silences
 * it; a failed notification is logged by id and the assign still answers.
 * No lead value, staff name or picker text is ever logged.
 */
@Injectable()
export class LeadAssigneesService {
  private readonly logger = new Logger(LeadAssigneesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly leads: LeadsService,
    private readonly notifications: NotificationsService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /**
   * The staff picker: eligible staff with a profile. A blank query previews
   * `LEAD_STAFF_PREVIEW_LIMIT` people with the caller first; a typed query
   * answers up to `LEAD_STAFF_SEARCH_LIMIT` matches by name. Current
   * assignees stay in the rows. The typed text is kept out of the query log.
   */
  async searchStaff(
    query: unknown,
    caller: LeadCaller,
  ): Promise<{ items: LeadStaffSummaryDTO[] }> {
    const term = normalizeSearchTerm(query);
    const builder = this.dataSource.manager
      .createQueryBuilder(User, 'staff')
      .comment(PRIVATE_PARAMETERS_COMMENT)
      .innerJoin(Profile, 'profile', '"profile"."user_id" = "staff"."id"')
      .where(LEAD_STAFF_ELIGIBLE_SQL)
      .select('staff.id', 'user_id')
      .addSelect('profile.slug', 'slug')
      .addSelect('profile.firstName', 'first_name')
      .addSelect('profile.lastName', 'last_name')
      .addSelect('profile.avatarUrl', 'avatar_url')
      .addSelect('profile.photoVisible', 'photo_visible');
    if (term === '') {
      builder
        .orderBy(LEAD_STAFF_CALLER_FIRST_SQL, 'ASC')
        .setParameter('callerId', caller.userId)
        .addOrderBy(LEAD_STAFF_FIRST_NAME_ORDER, 'ASC');
    } else {
      builder
        .andWhere(LEAD_STAFF_SEARCH_SQL, { term: `%${escapeLikeTerm(term)}%` })
        .orderBy(LEAD_STAFF_FIRST_NAME_ORDER, 'ASC');
    }
    builder
      .addOrderBy(LEAD_STAFF_LAST_NAME_ORDER, 'ASC')
      .addOrderBy(LEAD_STAFF_ID_ORDER, 'ASC')
      .limit(term === '' ? LEAD_STAFF_PREVIEW_LIMIT : LEAD_STAFF_SEARCH_LIMIT);
    const rows = await builder.getRawMany<LeadStaffPickerRow>();
    const profileRows = rows.map((row) => ({
      userId: row.user_id,
      profile: profileRowOf(row),
    }));
    const crops = await this.mediaCropService.getMany(
      profileRows
        .filter(({ profile }) => profile.photoVisible)
        .map(({ profile }) => profile.avatarUrl)
        .filter((avatarKey): avatarKey is string => Boolean(avatarKey)),
    );
    return {
      items: profileRows.map(({ userId, profile }) =>
        toLeadStaffSummary(userId, profile, crops),
      ),
    };
  }

  /** Puts a person in charge of a lead and answers the whole lead, read
   *  after the commit. The class comment lists the check order. */
  async assign(
    leadId: string,
    caller: LeadCaller,
    body: unknown,
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    const requestedId = assigneeIdOf(body);
    if (typeof requestedId !== 'string' || !isUUID(requestedId)) {
      throw leadError('LEAD_ASSIGNEE_NOT_FOUND', {
        status: HttpStatus.BAD_REQUEST,
      });
    }
    // isUUID accepts upper case; one spelling keeps the self check exact.
    const userId = requestedId.toLowerCase();
    const assignmentResult = await this.dataSource.transaction(
      async (manager) => {
        const lockedLeadId = await this.lockLeadRow(manager, leadId);
        const existingAssignment = await manager.findOne(LeadAssignee, {
          where: { leadId: lockedLeadId, userId },
          select: { userId: true },
        });
        if (existingAssignment) {
          return { isNewAssignment: false, lockedLeadId };
        }
        const eligibility = await leadStaffEligibility(manager, userId);
        if (eligibility.kind === 'not_found') {
          throw leadError('LEAD_ASSIGNEE_NOT_FOUND');
        }
        if (eligibility.kind === 'ineligible') {
          throw leadError('LEAD_ASSIGNEE_NOT_STAFF', {
            reason: eligibility.reason,
          });
        }
        const assigneeCount = await manager.count(LeadAssignee, {
          where: { leadId: lockedLeadId },
        });
        if (assigneeCount >= LEAD_MAX_ASSIGNEES) {
          throw leadError('LEAD_TOO_MANY_ASSIGNEES');
        }
        await manager.insert(LeadAssignee, {
          leadId: lockedLeadId,
          userId,
          assignedById: caller.userId,
        });
        await manager.save(
          LeadEntry,
          manager.create(LeadEntry, {
            leadId: lockedLeadId,
            kind: 'assignee_added',
            authorId: caller.userId,
            subjectUserId: userId,
          }),
        );
        await manager.query(TOUCH_LEAD_SQL, [lockedLeadId]);
        return { isNewAssignment: true, lockedLeadId };
      },
    );
    if (assignmentResult.isNewAssignment && userId !== caller.userId) {
      await this.notifyAssigned(assignmentResult.lockedLeadId, userId, caller);
    }
    return this.leads.getLead(leadId, caller);
  }

  /** Takes a person off a lead and answers the whole lead, read after the
   *  commit. No eligibility check: anyone in charge can be unassigned, the
   *  caller included. Sends no notification. */
  async unassign(
    leadId: string,
    userId: string,
    caller: LeadCaller,
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    if (!isUUID(userId)) {
      throw leadError('LEAD_ASSIGNEE_NOT_FOUND');
    }
    const assigneeId = userId.toLowerCase();
    await this.dataSource.transaction(async (manager) => {
      const lockedLeadId = await this.lockLeadRow(manager, leadId);
      const deleteResult = await manager.delete(LeadAssignee, {
        leadId: lockedLeadId,
        userId: assigneeId,
      });
      if (!deleteResult.affected) {
        return;
      }
      await manager.save(
        LeadEntry,
        manager.create(LeadEntry, {
          leadId: lockedLeadId,
          kind: 'assignee_removed',
          authorId: caller.userId,
          subjectUserId: assigneeId,
        }),
      );
      await manager.query(TOUCH_LEAD_SQL, [lockedLeadId]);
    });
    return this.leads.getLead(leadId, caller);
  }

  /** Takes the leads table lock, then locks the lead row for the rest of
   *  the transaction and answers its id, or throws `LEAD_NOT_FOUND`. The
   *  table lock comes first, as in every lead write, so assignment writes
   *  and lead updates queue in one order. */
  private async lockLeadRow(
    manager: EntityManager,
    leadId: string,
  ): Promise<string> {
    await manager.query(LOCK_LEADS_SQL);
    const lead = await manager.findOne(Lead, {
      where: { id: leadId },
      select: { id: true },
      lock: { mode: 'pessimistic_write' },
    });
    if (!lead) {
      throw leadError('LEAD_NOT_FOUND');
    }
    return lead.id;
  }

  /** Sends `lead_assigned` to the person put in charge, payload ids only
   *  and no `actorId` argument. A failure is logged by id and swallowed, so
   *  the committed assignment still answers. */
  private async notifyAssigned(
    leadId: string,
    userId: string,
    caller: LeadCaller,
  ): Promise<void> {
    try {
      await this.notifications.create(userId, NotificationType.LeadAssigned, {
        leadId,
        assignedById: caller.userId,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : 'unknown error';
      this.logger.warn(
        `Lead assignment notification failed (lead ${leadId}, recipient ${userId}, assigned by ${caller.userId}): ${errorName}`,
      );
    }
  }
}
