import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import type { PersonaWallPersonaRow } from '../subprofiles/persona-wall-response';
import {
  normalizeWallSearchTerm,
  personaWallPublicStateOf,
} from '../subprofiles/persona-wall.rules';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import {
  isSubprofileUnderTakedown,
  SUBPROFILE_MODERATION_SUBJECT_TYPE,
} from '../subprofiles/subprofile-takedown';
import { Lead } from './entities/lead.entity';
import { sanitizeLeadText } from './lead-input';
import {
  LEAD_PERSONA_FIELDS,
  type LeadPersonaRecord,
  type LeadPersonaSearchResultDTO,
  toLeadPersona,
} from './lead-response';
import { LEAD_PERSONA_SEARCH_LIMIT, leadError } from './leads.constants';

/** `LEAD_PERSONA_FIELDS` as a TypeORM select: persona columns only, so no
 *  owner column is ever read. */
const LEAD_PERSONA_SELECT = Object.fromEntries(
  LEAD_PERSONA_FIELDS.map((field) => [field, true]),
) as Record<(typeof LEAD_PERSONA_FIELDS)[number], true>;

/** The prefix that turns a persona search into a handle prefix search. */
const HANDLE_SEARCH_PREFIX = '@';

/** The avatar keys of persona rows, blanks dropped, for one batched crop
 *  lookup. */
function avatarKeysOf(
  rows: Pick<PersonaWallPersonaRow, 'avatarUrl'>[],
): string[] {
  return rows
    .map((row) => row.avatarUrl)
    .filter((avatarKey): avatarKey is string => Boolean(avatarKey));
}

/**
 * Persona reads for the leads directory: the picker search, the persona
 * summaries a lead and its entries name with their public state, and the
 * checks a link runs before it is written. Persona objects never carry owner
 * fields: every read selects persona columns only and every response is built
 * field by field through `toLeadPersona`. The picker offers only personas the
 * public directory shows, and a link is refused for any persona it hides.
 */
@Injectable()
export class LeadPersonaService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly publicRead: SubprofilePublicReadService,
    private readonly contentModeration: ContentModerationService,
    private readonly mediaCropService: MediaCropService,
  ) {}

  /** The persona picker search, at most 20 rows. A term starting with `@`
   *  searches handles by prefix; any other term searches the wall haystack.
   *  A blank, repeated or missing query, or a bare `@`, answers no items and
   *  searches nothing. A NUL is dropped before the checks, so it never
   *  reaches a query parameter. Each row is marked with the lead it is linked
   *  to, read in one query, and its avatar crop comes from one batched
   *  lookup. */
  async searchPersonas(
    query: unknown,
  ): Promise<{ items: LeadPersonaSearchResultDTO[] }> {
    const searchTerm = normalizeWallSearchTerm(
      typeof query === 'string' ? sanitizeLeadText(query) : query,
    );
    if (!searchTerm) {
      return { items: [] };
    }
    const rows = await this.findPickerRows(searchTerm);
    if (rows.length === 0) {
      return { items: [] };
    }
    const [linkedLeads, crops] = await Promise.all([
      this.dataSource.manager.find(Lead, {
        where: { linkedSubprofileId: In(rows.map((row) => row.id)) },
        select: { id: true, name: true, linkedSubprofileId: true },
      }),
      this.mediaCropService.getMany(avatarKeysOf(rows)),
    ]);
    const linkedLeadBySubprofileId = new Map(
      linkedLeads.map((lead) => [lead.linkedSubprofileId, lead]),
    );
    return {
      items: rows.map((row) => {
        const linkedLead = linkedLeadBySubprofileId.get(row.id);
        return {
          persona: toLeadPersona(row, crops),
          linkedLead: linkedLead
            ? { id: linkedLead.id, name: linkedLead.name }
            : null,
        };
      }),
    };
  }

  /** The persona summaries and public states of the given ids, keyed by id:
   *  one `Subprofile` read of persona columns only and one takedown batch. An
   *  empty list runs no query; an id with no persona row is left out. The
   *  caller reads the avatar crops with its own batch. */
  async loadPersonaRecords(
    subprofileIds: string[],
  ): Promise<Map<string, LeadPersonaRecord>> {
    const uniqueSubprofileIds = [...new Set(subprofileIds)];
    if (uniqueSubprofileIds.length === 0) {
      return new Map();
    }
    const [personas, takedownStates] = await Promise.all([
      this.dataSource.manager.find(Subprofile, {
        where: { id: In(uniqueSubprofileIds) },
        select: LEAD_PERSONA_SELECT,
      }),
      this.contentModeration.statesFor(
        SUBPROFILE_MODERATION_SUBJECT_TYPE,
        uniqueSubprofileIds,
      ),
    ]);
    const records = new Map<string, LeadPersonaRecord>();
    for (const persona of personas) {
      const takedownState = takedownStates.get(persona.id);
      const isTakenDown = Boolean(
        takedownState?.hidden || takedownState?.removed,
      );
      records.set(persona.id, {
        row: {
          id: persona.id,
          handle: persona.handle,
          displayName: persona.displayName,
          kind: persona.kind,
          avatarUrl: persona.avatarUrl,
        },
        publicState: personaWallPublicStateOf(persona, isTakenDown),
      });
    }
    return records;
  }

  /** Checks a persona can be linked to the lead, inside the caller's
   *  transaction, in the contract's order: the persona exists (read under a
   *  share lock, so a delete cannot remove it before the write); then it is
   *  free of every other lead; then the public directory shows it. */
  async assertLinkable(
    manager: EntityManager,
    leadId: string,
    subprofileId: string,
  ): Promise<void> {
    const persona = await manager.findOne(Subprofile, {
      where: { id: subprofileId },
      select: { id: true, status: true, visibility: true, removedAt: true },
      lock: { mode: 'pessimistic_read' },
    });
    if (!persona) {
      throw leadError('LEAD_PERSONA_NOT_FOUND');
    }
    const otherLead = await manager.findOne(Lead, {
      where: { linkedSubprofileId: persona.id, id: Not(leadId) },
      select: { id: true, name: true },
    });
    if (otherLead) {
      throw leadError('LEAD_PERSONA_TAKEN', {
        leadId: otherLead.id,
        leadName: otherLead.name,
      });
    }
    const isTakenDown = await isSubprofileUnderTakedown(
      this.contentModeration,
      persona.id,
    );
    const publicState = personaWallPublicStateOf(persona, isTakenDown);
    if (publicState !== 'shown') {
      throw leadError('LEAD_PERSONA_NOT_LISTED', { publicState });
    }
  }

  /** The picker rows for a normalized, non-blank term. A bare `@` reads no
   *  rows. */
  private findPickerRows(searchTerm: string): Promise<PersonaWallPersonaRow[]> {
    if (!searchTerm.startsWith(HANDLE_SEARCH_PREFIX)) {
      return this.publicRead.searchWallPersonas(
        searchTerm,
        LEAD_PERSONA_SEARCH_LIMIT,
      );
    }
    const handlePrefix = searchTerm.slice(HANDLE_SEARCH_PREFIX.length).trim();
    if (!handlePrefix) {
      return Promise.resolve([]);
    }
    return this.publicRead.searchPersonasByHandlePrefix(
      handlePrefix,
      LEAD_PERSONA_SEARCH_LIMIT,
    );
  }
}
