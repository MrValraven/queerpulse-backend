import { HttpException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import {
  DataSource,
  EntityManager,
  In,
  Not,
  QueryFailedError,
  Raw,
  SelectQueryBuilder,
} from 'typeorm';
import type { CropRect } from '../media-crops/crop-rect';
import { MediaCropService } from '../media-crops/media-crops.service';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  foldedHaystack,
  foldedSearchTerm,
  foldedTextExpression,
} from '../search/search-text';
import { escapeLikeTerm } from '../common/like-escape';
import { lisbonWallDay } from '../subprofiles/persona-wall.rules';
import { Profile } from '../users/entities/profile.entity';
import type {
  CreateLeadDto,
  ListLeadsQuery,
  UpdateLeadDto,
} from './dto/leads.dto';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { LEAD_AUDIT_ACTIONS, writeLeadAudit } from './lead-audit';
import { encodeLeadCursor, LEAD_CURSOR_UPDATED_AT_SQL } from './lead-cursor';
import {
  type LeadListFilters,
  type NormalizedLeadLink,
  normalizeLeadCreate,
  normalizeLeadListFilters,
  normalizeLeadUpdate,
} from './lead-input';
import { leadLinkKey } from './lead-link-key';
import { LeadPersonaService } from './lead-persona.service';
import {
  canEditLeadEntry,
  type LeadAuthorProfileRow,
  type LeadCaller,
  type LeadDTO,
  type LeadEntryDTO,
  type LeadLinkedPersonaDTO,
  type LeadListPageDTO,
  type LeadPersonaRecord,
  toLead,
  toLeadEntry,
  toLeadEntryAuthor,
  toLeadLinkedPersona,
  toLeadListItem,
  toLeadPersona,
} from './lead-response';
import {
  LEAD_PAGE_SIZE,
  LEAD_STAGES,
  type LeadRefusalCode,
  type LeadStage,
  leadError,
  OPEN_LEAD_STAGES,
} from './leads.constants';

/** Every lead write that checks a unique value takes this first, so two
 *  writes can never both pass the email or link check and then both insert.
 *  Staff only, and a handful of writes a day. */
export const LOCK_LEADS_SQL = 'LOCK TABLE "leads" IN SHARE ROW EXCLUSIVE MODE';

/** The open stages as a SQL list, built from the constant so the two cannot
 *  drift. The values are fixed literals with no user input. */
const OPEN_STAGE_LIST = OPEN_LEAD_STAGES.map((stage) => `'${stage}'`).join(
  ', ',
);

/** A lead whose follow-up is due on `:today`, the Lisbon calendar day: an
 *  open stage and a follow-up day on or before today. */
export const LEAD_IS_DUE_SQL = `("lead"."stage" IN (${OPEN_STAGE_LIST}) AND "lead"."follow_up_on" IS NOT NULL AND "lead"."follow_up_on" <= CAST(:today AS date))`;

/** 0 for a due lead, 1 for every other lead: the first sort key. */
export const LEAD_DUE_RANK_SQL = `CASE WHEN ${LEAD_IS_DUE_SQL} THEN 0 ELSE 1 END`;

/** The follow-up day of a due lead and NULL for every other lead: the second
 *  sort key, so due leads list oldest follow-up first. */
export const LEAD_DUE_ON_SQL = `CASE WHEN ${LEAD_IS_DUE_SQL} THEN "lead"."follow_up_on" END`;

const CURSOR_RANK = 'CAST(:cursorRank AS int)';
const CURSOR_DUE_ON = 'CAST(:cursorDueOn AS date)';
const CURSOR_UPDATED_AT = 'CAST(:cursorUpdatedAt AS timestamptz)';
const UPDATED_AFTER_CURSOR = `("lead"."updated_at" < ${CURSOR_UPDATED_AT} OR ("lead"."updated_at" = ${CURSOR_UPDATED_AT} AND "lead"."id" < CAST(:cursorId AS uuid)))`;

/** The rows after a cursor `(rank, dueOn, updatedAt, id)` in the list order
 *  `due_rank ASC, due_on ASC NULLS LAST, updated_at DESC, id DESC`. */
export const LEAD_AFTER_CURSOR_SQL = `(${LEAD_DUE_RANK_SQL} > ${CURSOR_RANK}
  OR (${LEAD_DUE_RANK_SQL} = ${CURSOR_RANK} AND ${CURSOR_RANK} = 0 AND ("lead"."follow_up_on" > ${CURSOR_DUE_ON} OR ("lead"."follow_up_on" = ${CURSOR_DUE_ON} AND ${UPDATED_AFTER_CURSOR})))
  OR (${LEAD_DUE_RANK_SQL} = ${CURSOR_RANK} AND ${CURSOR_RANK} = 1 AND ${UPDATED_AFTER_CURSOR}))`;

/** The list search: the folded name and email, or the folded link text,
 *  contains `:term` (already escaped and wrapped in `%`). */
export const LEAD_SEARCH_SQL = `(${foldedHaystack('lead', ['name', 'email'])} LIKE ${foldedSearchTerm('term')} ESCAPE '\\' OR ${foldedTextExpression('"lead"."links"::text')} LIKE ${foldedSearchTerm('term')} ESCAPE '\\')`;

/** `$1` the page's lead ids. One row per lead with its note count and the
 *  time of its newest entry. */
export const LEAD_ENTRY_STATS_SQL = `SELECT "lead_id", (COUNT(*) FILTER (WHERE "kind" = 'note'))::int AS "note_count", MAX("created_at") AS "last_entry_at" FROM "lead_entries" WHERE "lead_id" = ANY($1::uuid[]) GROUP BY "lead_id"`;

/** Select alias of `LEAD_DUE_RANK_SQL` on the list page. */
export const LEAD_DUE_RANK_ALIAS = 'due_rank';
/** Select alias of `LEAD_DUE_ON_SQL` on the list page. */
export const LEAD_DUE_ON_ALIAS = 'due_on';
/** Select alias of `LEAD_CURSOR_UPDATED_AT_SQL` on the list page. */
export const LEAD_CURSOR_UPDATED_AT_ALIAS = 'cursor_updated_at';

const POSTGRES_UNIQUE_VIOLATION = '23505';
const POSTGRES_CHECK_VIOLATION = '23514';
const LEAD_EMAIL_UNIQUE_INDEX = 'UQ_leads_email';
const LEAD_PERSONA_UNIQUE_CONSTRAINT = 'UQ_leads_linked_subprofile';

/** The code each leads CHECK answers if a row ever reached it. The field
 *  checks run first, so these stay a backstop that keeps the failing row
 *  (and the lead data in the driver's detail text) out of the error path.
 *  The entry kind and stage CHECKs are left out: the service alone writes
 *  those columns. */
const LEAD_CHECK_REFUSALS: Readonly<Record<string, LeadRefusalCode>> = {
  CHK_leads_name: 'LEAD_NAME_REQUIRED',
  CHK_leads_type: 'LEAD_TYPE_INVALID',
  CHK_leads_stage: 'LEAD_STAGE_INVALID',
  CHK_leads_email: 'LEAD_EMAIL_INVALID',
  CHK_leads_links: 'LEAD_TOO_MANY_LINKS',
  CHK_lead_entries_note_body: 'LEAD_NOTE_EMPTY',
  CHK_lead_entries_body_length: 'LEAD_NOTE_TOO_LONG',
};

/** The unique values a write carries, read back to name the holding lead
 *  when a unique index fires. */
interface LeadUniqueValues {
  email: string | null;
  subprofileId: string | null;
}

/** The raw columns the list page reads beside each lead. */
interface LeadPageRawRow {
  due_rank: number | string;
  cursor_updated_at: string;
}

/** One row of `LEAD_ENTRY_STATS_SQL`. */
interface LeadEntryStatsRow {
  lead_id: string;
  note_count: number | string;
  last_entry_at: Date | string;
}

/** One row of the stage count. */
interface LeadStageCountRow {
  stage: string;
  count: number | string;
}

/** The Postgres error code and constraint name of a failed query, or null
 *  for any other error. */
function violatedConstraintOf(
  error: unknown,
): { code: string; constraint: string } | null {
  if (!(error instanceof QueryFailedError)) {
    return null;
  }
  const driverError = error.driverError as
    { code?: unknown; constraint?: unknown } | undefined;
  const code = driverError?.code;
  const constraint = driverError?.constraint;
  if (typeof code !== 'string' || typeof constraint !== 'string') {
    return null;
  }
  return { code, constraint };
}

/** The refusal for a CHECK violation on `leads` or `lead_entries`, or null
 *  for any other error. Shared with `LeadEntriesService`. */
export function leadCheckRefusal(error: unknown): HttpException | null {
  const violation = violatedConstraintOf(error);
  if (violation?.code !== POSTGRES_CHECK_VIOLATION) {
    return null;
  }
  const code = LEAD_CHECK_REFUSALS[violation.constraint];
  return code === undefined ? null : leadError(code);
}

/** The avatar keys of persona records, blanks dropped. */
function personaAvatarKeysOf(records: Iterable<LeadPersonaRecord>): string[] {
  return [...records]
    .map((record) => record.row.avatarUrl)
    .filter((avatarKey): avatarKey is string => Boolean(avatarKey));
}

/** Whether two link lists hold the same text in the same order. */
function hasSameLinks(first: string[], second: string[]): boolean {
  return (
    first.length === second.length &&
    first.every((link, index) => link === second[index])
  );
}

/** A Date from a driver timestamp, which arrives as a Date or as text. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Leads: the staff leads directory at `admin/leads` (list, due count, create,
 * read, update, delete). Every refusal goes through `leadError` with its
 * contract code, in the contract's check order, and a malformed id answers
 * its not-found code before any query runs. The field checks mirror every
 * CHECK, so the driver never sees a failing row, and the email, link and
 * persona checks run under a table lock before any write; a unique index
 * that still fires answers its code. No lead value is logged, and audit rows
 * carry ids only.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly leadPersonas: LeadPersonaService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /** One page of the list, due follow-ups first. The filters are checked
   *  before any query. A cursor carries the Lisbon day its first page read,
   *  so a later page keeps that page's order across midnight. The stage
   *  counts read the `q` and `type` filters only. */
  async listLeads(
    query: ListLeadsQuery,
    now: Date = new Date(),
  ): Promise<LeadListPageDTO> {
    const filters = normalizeLeadListFilters(query);
    const today = filters.cursor?.today ?? lisbonWallDay(now);
    const manager = this.dataSource.manager;

    const pageQuery = manager
      .createQueryBuilder(Lead, 'lead')
      .setParameter('today', today);
    this.applyLeadFilters(pageQuery, filters);
    if (filters.stage !== null) {
      pageQuery.andWhere('lead.stage = :stage', { stage: filters.stage });
    }
    if (filters.isDueOnly) {
      pageQuery.andWhere(LEAD_IS_DUE_SQL);
    }
    if (filters.cursor !== null) {
      pageQuery.andWhere(LEAD_AFTER_CURSOR_SQL, {
        cursorRank: filters.cursor.dueRank,
        cursorDueOn: filters.cursor.dueOn,
        cursorUpdatedAt: filters.cursor.updatedAt,
        cursorId: filters.cursor.leadId,
      });
    }
    const { raw, entities } = await pageQuery
      .addSelect(LEAD_DUE_RANK_SQL, LEAD_DUE_RANK_ALIAS)
      .addSelect(LEAD_DUE_ON_SQL, LEAD_DUE_ON_ALIAS)
      .addSelect(LEAD_CURSOR_UPDATED_AT_SQL, LEAD_CURSOR_UPDATED_AT_ALIAS)
      .orderBy(LEAD_DUE_RANK_ALIAS, 'ASC')
      .addOrderBy(LEAD_DUE_ON_ALIAS, 'ASC', 'NULLS LAST')
      .addOrderBy('lead.updatedAt', 'DESC')
      .addOrderBy('lead.id', 'DESC')
      .limit(LEAD_PAGE_SIZE + 1)
      .getRawAndEntities<LeadPageRawRow>();

    const countQuery = manager.createQueryBuilder(Lead, 'lead');
    this.applyLeadFilters(countQuery, filters);
    const countRows = await countQuery
      .select('lead.stage', 'stage')
      .addSelect('COUNT(*)::int', 'count')
      .groupBy('lead.stage')
      .getRawMany<LeadStageCountRow>();

    const hasNextPage = entities.length > LEAD_PAGE_SIZE;
    const pageLeads = entities.slice(0, LEAD_PAGE_SIZE);
    const lastLead = pageLeads[pageLeads.length - 1];
    const lastRaw = raw[pageLeads.length - 1];
    let nextCursor: string | null = null;
    if (hasNextPage && lastLead && lastRaw) {
      const isLastDue = Number(lastRaw.due_rank) === 0;
      // `due_on` equals the follow-up day exactly when the row is due, and
      // the entity carries that day as `YYYY-MM-DD` text.
      nextCursor = encodeLeadCursor({
        today,
        dueRank: isLastDue ? 0 : 1,
        dueOn: isLastDue ? lastLead.followUpOn : null,
        updatedAt: lastRaw.cursor_updated_at,
        leadId: lastLead.id,
      });
    }

    const stageCounts = Object.fromEntries(
      LEAD_STAGES.map((stage) => [stage, 0]),
    ) as Record<LeadStage, number>;
    for (const row of countRows) {
      if ((LEAD_STAGES as readonly string[]).includes(row.stage)) {
        stageCounts[row.stage as LeadStage] = Number(row.count);
      }
    }
    const totalCount = LEAD_STAGES.reduce(
      (sum, stage) => sum + stageCounts[stage],
      0,
    );

    const pageIds = pageLeads.map((lead) => lead.id);
    const statsRows =
      pageIds.length === 0
        ? []
        : await manager.query<LeadEntryStatsRow[]>(LEAD_ENTRY_STATS_SQL, [
            pageIds,
          ]);
    const statsByLeadId = new Map(statsRows.map((row) => [row.lead_id, row]));
    const linkedIds = pageLeads
      .map((lead) => lead.linkedSubprofileId)
      .filter((subprofileId): subprofileId is string => subprofileId !== null);
    const personaRecords = await this.leadPersonas.loadPersonaRecords([
      ...new Set(linkedIds),
    ]);
    const crops = await this.mediaCropService.getMany(
      personaAvatarKeysOf(personaRecords.values()),
    );

    const items = pageLeads.map((lead) => {
      const stats = statsByLeadId.get(lead.id);
      return toLeadListItem(
        lead,
        {
          noteCount: stats ? Number(stats.note_count) : 0,
          lastEntryAt: stats ? asDate(stats.last_entry_at) : lead.createdAt,
        },
        this.linkedPersonaOf(lead, personaRecords, crops),
        today,
      );
    });
    return { items, nextCursor, stageCounts, totalCount };
  }

  /** How many leads have a follow-up due on the Lisbon day of `now`: the
   *  nav badge. */
  async dueCount(now: Date = new Date()): Promise<{ count: number }> {
    const count = await this.dataSource.manager
      .createQueryBuilder(Lead, 'lead')
      .setParameter('today', lisbonWallDay(now))
      .where(LEAD_IS_DUE_SQL)
      .getCount();
    return { count };
  }

  /** Creates a lead with its `created` entry and, when given, its first note.
   *  Every field check runs before the transaction; the email and link
   *  checks run inside it, after the table lock. Answers the whole lead. */
  async createLead(
    caller: LeadCaller,
    body: CreateLeadDto,
    now: Date = new Date(),
  ): Promise<LeadDTO> {
    const lead = normalizeLeadCreate(body);
    const leadId = await this.runLeadWrite(
      async (manager) => {
        await manager.query(LOCK_LEADS_SQL);
        if (lead.email !== null) {
          const emailHolder = await manager.findOne(Lead, {
            where: { email: lead.email },
            select: { id: true, name: true },
          });
          if (emailHolder) {
            throw leadError('LEAD_EMAIL_TAKEN', {
              leadId: emailHolder.id,
              leadName: emailHolder.name,
            });
          }
        }
        await this.assertNoLinkClash(manager, lead.links, null);

        const savedLead = await manager.save(
          Lead,
          manager.create(Lead, {
            name: lead.name,
            type: lead.type,
            stage: lead.stage,
            location: lead.location,
            email: lead.email,
            phone: lead.phone,
            links: lead.links.map((link) => link.text),
            followUpOn: lead.followUpOn,
            linkedSubprofileId: null,
            createdById: caller.userId,
          }),
        );
        await manager.save(
          LeadEntry,
          manager.create(LeadEntry, {
            leadId: savedLead.id,
            kind: 'created',
            toStage: lead.stage,
            authorId: caller.userId,
          }),
        );
        if (lead.note !== null) {
          await manager.save(
            LeadEntry,
            manager.create(LeadEntry, {
              leadId: savedLead.id,
              kind: 'note',
              body: lead.note,
              authorId: caller.userId,
            }),
          );
        }
        return savedLead.id;
      },
      { email: lead.email, subprofileId: null },
    );
    return this.getLead(leadId, caller, now);
  }

  /** The whole lead with its entries newest first. One read each of the
   *  lead, its entries, their authors' profiles, the personas they name
   *  (with their takedowns) and the avatar crops. */
  async getLead(
    leadId: string,
    caller: LeadCaller,
    now: Date = new Date(),
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    const manager = this.dataSource.manager;
    const lead = await manager.findOne(Lead, { where: { id: leadId } });
    if (!lead) {
      throw leadError('LEAD_NOT_FOUND');
    }
    const entries = await manager.find(LeadEntry, {
      where: { leadId: lead.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });

    const authorIds = [
      ...new Set(
        entries
          .map((entry) => entry.authorId)
          .filter((authorId): authorId is string => authorId !== null),
      ),
    ];
    const personaIds = [
      ...new Set(
        [
          lead.linkedSubprofileId,
          ...entries.map((entry) => entry.subprofileId),
        ].filter(
          (subprofileId): subprofileId is string => subprofileId !== null,
        ),
      ),
    ];
    const [profiles, personaRecords] = await Promise.all([
      authorIds.length === 0
        ? Promise.resolve([] as Profile[])
        : manager.find(Profile, {
            where: { userId: In(authorIds) },
            select: {
              userId: true,
              firstName: true,
              lastName: true,
              avatarUrl: true,
            },
          }),
      this.leadPersonas.loadPersonaRecords(personaIds),
    ]);
    const profileByUserId = new Map<string, LeadAuthorProfileRow>(
      profiles.map((profile) => [profile.userId, profile]),
    );
    const crops = await this.mediaCropService.getMany([
      ...personaAvatarKeysOf(personaRecords.values()),
      ...profiles
        .map((profile) => profile.avatarUrl)
        .filter((avatarKey): avatarKey is string => Boolean(avatarKey)),
    ]);

    const entryDTOs: LeadEntryDTO[] = entries.map((entry) => {
      const author =
        entry.authorId === null
          ? null
          : toLeadEntryAuthor(
              entry.authorId,
              profileByUserId.get(entry.authorId) ?? null,
              crops,
            );
      const personaRecord =
        entry.subprofileId === null
          ? undefined
          : personaRecords.get(entry.subprofileId);
      const persona = personaRecord
        ? toLeadPersona(personaRecord.row, crops)
        : null;
      return toLeadEntry(
        entry,
        author,
        persona,
        canEditLeadEntry(entry, caller),
      );
    });
    return toLead(
      lead,
      this.linkedPersonaOf(lead, personaRecords, crops),
      entryDTOs,
      lisbonWallDay(now),
    );
  }

  /**
   * Updates the fields the body sent. The field checks run before the
   * transaction; inside it, after the table lock and a row lock on the lead,
   * a changed email, the sent links and a newly linked persona are checked
   * against every other lead. Sending a field's current value is no change.
   * Writes the changed columns (which stamps `updated_at`), then a
   * `stage_changed`, `persona_unlinked` and `persona_linked` entry as they
   * apply, then one audit row per unlink and link. Answers the whole lead.
   *
   * One race stays open: linking, unlinking or replacing a persona while its
   * owner unlinks or deletes that persona can deadlock. Postgres usually
   * aborts the owner's unlink, which the member retries. This is accepted,
   * the same as the team-link case in `subprofiles/subprofile-unlink-rekey.ts`.
   */
  async updateLead(
    leadId: string,
    caller: LeadCaller,
    body: UpdateLeadDto,
    now: Date = new Date(),
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    const update = normalizeLeadUpdate(body);
    await this.runLeadWrite(
      async (manager) => {
        await manager.query(LOCK_LEADS_SQL);
        const lead = await manager.findOne(Lead, {
          where: { id: leadId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lead) {
          throw leadError('LEAD_NOT_FOUND');
        }

        const changes: Partial<
          Pick<
            Lead,
            | 'name'
            | 'type'
            | 'stage'
            | 'location'
            | 'email'
            | 'phone'
            | 'links'
            | 'followUpOn'
            | 'linkedSubprofileId'
          >
        > = {};
        if (update.name !== undefined && update.name !== lead.name) {
          changes.name = update.name;
        }
        if (update.type !== undefined && update.type !== lead.type) {
          changes.type = update.type;
        }
        if (update.stage !== undefined && update.stage !== lead.stage) {
          changes.stage = update.stage;
        }
        if (
          update.location !== undefined &&
          update.location !== lead.location
        ) {
          changes.location = update.location;
        }
        if (update.email !== undefined && update.email !== lead.email) {
          changes.email = update.email;
        }
        if (update.phone !== undefined && update.phone !== lead.phone) {
          changes.phone = update.phone;
        }
        if (update.links !== undefined) {
          const linkTexts = update.links.map((link) => link.text);
          if (!hasSameLinks(linkTexts, lead.links)) {
            changes.links = linkTexts;
          }
        }
        if (
          update.followUpOn !== undefined &&
          update.followUpOn !== lead.followUpOn
        ) {
          changes.followUpOn = update.followUpOn;
        }
        if (
          update.linkedSubprofileId !== undefined &&
          update.linkedSubprofileId !== lead.linkedSubprofileId
        ) {
          changes.linkedSubprofileId = update.linkedSubprofileId;
        }

        if (changes.email !== undefined && changes.email !== null) {
          const emailHolder = await manager.findOne(Lead, {
            where: { email: changes.email, id: Not(lead.id) },
            select: { id: true, name: true },
          });
          if (emailHolder) {
            throw leadError('LEAD_EMAIL_TAKEN', {
              leadId: emailHolder.id,
              leadName: emailHolder.name,
            });
          }
        }
        if (update.links !== undefined) {
          await this.assertNoLinkClash(manager, update.links, lead.id);
        }
        const newPersonaId = changes.linkedSubprofileId;
        if (typeof newPersonaId === 'string') {
          await this.leadPersonas.assertLinkable(
            manager,
            lead.id,
            newPersonaId,
          );
        }

        if (Object.keys(changes).length === 0) {
          return;
        }
        await manager.update(Lead, lead.id, changes);

        const previousPersonaId = lead.linkedSubprofileId;
        const isPersonaChanged = changes.linkedSubprofileId !== undefined;
        if (changes.stage !== undefined) {
          await manager.save(
            LeadEntry,
            manager.create(LeadEntry, {
              leadId: lead.id,
              kind: 'stage_changed',
              fromStage: lead.stage,
              toStage: changes.stage,
              authorId: caller.userId,
            }),
          );
        }
        if (isPersonaChanged && previousPersonaId !== null) {
          await manager.save(
            LeadEntry,
            manager.create(LeadEntry, {
              leadId: lead.id,
              kind: 'persona_unlinked',
              subprofileId: previousPersonaId,
              authorId: caller.userId,
            }),
          );
        }
        if (typeof newPersonaId === 'string') {
          await manager.save(
            LeadEntry,
            manager.create(LeadEntry, {
              leadId: lead.id,
              kind: 'persona_linked',
              subprofileId: newPersonaId,
              authorId: caller.userId,
            }),
          );
        }

        const auditRepository = manager.getRepository(ModAuditLog);
        if (isPersonaChanged && previousPersonaId !== null) {
          await writeLeadAudit(auditRepository, {
            actorId: caller.userId,
            action: LEAD_AUDIT_ACTIONS.personaUnlinked,
            leadId: lead.id,
            subprofileId: previousPersonaId,
          });
        }
        if (typeof newPersonaId === 'string') {
          await writeLeadAudit(auditRepository, {
            actorId: caller.userId,
            action: LEAD_AUDIT_ACTIONS.personaLinked,
            leadId: lead.id,
            subprofileId: newPersonaId,
          });
        }
      },
      {
        email: update.email ?? null,
        subprofileId: update.linkedSubprofileId ?? null,
      },
    );
    return this.getLead(leadId, caller, now);
  }

  /** Deletes a lead and, through the cascade, its entries, after writing the
   *  `lead_deleted` audit row in the same transaction. The table lock comes
   *  first, as in every lead write, so a delete and an update queue in one
   *  order and never deadlock on the row lock. */
  async deleteLead(leadId: string, caller: LeadCaller): Promise<{ ok: true }> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    await this.runLeadWrite(
      async (manager) => {
        await manager.query(LOCK_LEADS_SQL);
        const lead = await manager.findOne(Lead, {
          where: { id: leadId },
          select: { id: true, linkedSubprofileId: true },
          lock: { mode: 'pessimistic_write' },
        });
        if (!lead) {
          throw leadError('LEAD_NOT_FOUND');
        }
        await writeLeadAudit(manager.getRepository(ModAuditLog), {
          actorId: caller.userId,
          action: LEAD_AUDIT_ACTIONS.deleted,
          leadId: lead.id,
          subprofileId: lead.linkedSubprofileId,
        });
        await manager.delete(Lead, { id: lead.id });
      },
      { email: null, subprofileId: null },
    );
    return { ok: true };
  }

  /** The search and type filters, shared by the page and the stage count. */
  private applyLeadFilters(
    queryBuilder: SelectQueryBuilder<Lead>,
    filters: Pick<LeadListFilters, 'term' | 'type'>,
  ): void {
    if (filters.term) {
      queryBuilder.andWhere(LEAD_SEARCH_SQL, {
        term: `%${escapeLikeTerm(filters.term)}%`,
      });
    }
    if (filters.type !== null) {
      queryBuilder.andWhere('lead.type = :type', { type: filters.type });
    }
  }

  /** The linked persona of a lead with its public state, or null when it
   *  has none or the persona row is gone. */
  private linkedPersonaOf(
    lead: Pick<Lead, 'linkedSubprofileId'>,
    personaRecords: Map<string, LeadPersonaRecord>,
    crops: Map<string, CropRect>,
  ): LeadLinkedPersonaDTO | null {
    if (lead.linkedSubprofileId === null) {
      return null;
    }
    const record = personaRecords.get(lead.linkedSubprofileId);
    return record ? toLeadLinkedPersona(record, crops) : null;
  }

  /** Throws `LEAD_LINK_TAKEN` for the first submitted link that shares a
   *  link key with a link of another lead. */
  private async assertNoLinkClash(
    manager: EntityManager,
    links: NormalizedLeadLink[],
    exceptLeadId: string | null,
  ): Promise<void> {
    const clash = await this.findLinkClash(manager, links, exceptLeadId);
    if (clash) {
      throw leadError('LEAD_LINK_TAKEN', {
        leadId: clash.lead.id,
        leadName: clash.lead.name,
        index: clash.submittedIndex,
      });
    }
  }

  /** The first submitted link, in submitted order, whose link key another
   *  lead also holds, with that lead. Reads `id, name, links` of every other
   *  lead that has links and keys them in code with `leadLinkKey`. No links
   *  runs no query. */
  private async findLinkClash(
    manager: EntityManager,
    links: NormalizedLeadLink[],
    exceptLeadId: string | null,
  ): Promise<{
    lead: Pick<Lead, 'id' | 'name'>;
    submittedIndex: number;
  } | null> {
    if (links.length === 0) {
      return null;
    }
    const nonEmptyLinksFilter = Raw((column) => `${column} <> '[]'::jsonb`);
    const otherLeads = await manager.find(Lead, {
      where:
        exceptLeadId === null
          ? { links: nonEmptyLinksFilter }
          : { id: Not(exceptLeadId), links: nonEmptyLinksFilter },
      select: { id: true, name: true, links: true },
    });
    const holderByKey = new Map<string, Pick<Lead, 'id' | 'name'>>();
    for (const otherLead of otherLeads) {
      for (const storedLink of otherLead.links) {
        const key = leadLinkKey(storedLink);
        if (key !== null && !holderByKey.has(key)) {
          holderByKey.set(key, { id: otherLead.id, name: otherLead.name });
        }
      }
    }
    for (const link of links) {
      const holder = holderByKey.get(link.key);
      if (holder) {
        return { lead: holder, submittedIndex: link.submittedIndex };
      }
    }
    return null;
  }

  /** Runs one lead write in a transaction. A unique index that fires answers
   *  `LEAD_EMAIL_TAKEN` or `LEAD_PERSONA_TAKEN` with the holding lead (no
   *  extras when it is gone), and a CHECK answers its field code, so no
   *  driver error carrying lead data leaves the service. Any other error is
   *  rethrown unchanged. */
  private async runLeadWrite<T>(
    work: (manager: EntityManager) => Promise<T>,
    unique: LeadUniqueValues,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      const refusal =
        (await this.uniqueRefusal(error, unique)) ?? leadCheckRefusal(error);
      if (refusal) {
        throw refusal;
      }
      throw error;
    }
  }

  /** The refusal for a unique violation on the lead email or persona link,
   *  or null for any other error. */
  private async uniqueRefusal(
    error: unknown,
    unique: LeadUniqueValues,
  ): Promise<HttpException | null> {
    const violation = violatedConstraintOf(error);
    if (violation?.code !== POSTGRES_UNIQUE_VIOLATION) {
      return null;
    }
    if (violation.constraint === LEAD_EMAIL_UNIQUE_INDEX) {
      const holder =
        unique.email === null
          ? null
          : await this.dataSource.manager.findOne(Lead, {
              where: { email: unique.email },
              select: { id: true, name: true },
            });
      return leadError(
        'LEAD_EMAIL_TAKEN',
        holder ? { leadId: holder.id, leadName: holder.name } : undefined,
      );
    }
    if (violation.constraint === LEAD_PERSONA_UNIQUE_CONSTRAINT) {
      const holder =
        unique.subprofileId === null
          ? null
          : await this.dataSource.manager.findOne(Lead, {
              where: { linkedSubprofileId: unique.subprofileId },
              select: { id: true, name: true },
            });
      return leadError(
        'LEAD_PERSONA_TAKEN',
        holder ? { leadId: holder.id, leadName: holder.name } : undefined,
      );
    }
    return null;
  }
}
