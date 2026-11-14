import { HttpException, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager, FindOptionsSelect } from 'typeorm';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { normalizeNoteBody } from './lead-input';
import {
  canEditLeadEntry,
  canRevertLeadEntry,
  type LeadCaller,
  type LeadDTO,
} from './lead-response';
import {
  LEAD_REVERT_WINDOW_MS,
  leadError,
  type LeadRevertRefusalReason,
} from './leads.constants';
import {
  leadCheckRefusal,
  LeadsService,
  LOCK_LEADS_SQL,
} from './leads.service';

/** `$1` the lead id. Stamps the lead after a note write: `manager.update`
 *  with no column to set throws, so the stamp is raw SQL. */
export const TOUCH_LEAD_SQL =
  'UPDATE "leads" SET "updated_at" = now() WHERE "id" = $1';

/** The `body` property of a note route's request body, or undefined when
 *  the body is no object. */
function noteTextOf(requestBody: unknown): unknown {
  if (typeof requestBody !== 'object' || requestBody === null) {
    return undefined;
  }
  return (requestBody as { body?: unknown }).body;
}

/** The 409 a revert answers for one failing check. */
function revertRefusal(reason: LeadRevertRefusalReason): HttpException {
  return leadError('LEAD_ENTRY_NOT_REVERTIBLE', { reason });
}

/**
 * Leads: the notes on a lead's entry log (add, edit, delete) and the revert
 * of a recent stage change. Every refusal goes through `leadError` in the
 * contract's check order: the id shapes and the note text are checked before
 * any query, then the lead and the entry are read inside the write's
 * transaction with the lead row locked. Notes change by their author or an
 * Admin; a stage change is reverted by its author or an Admin while it is the
 * newest one, the lead still sits in its stage and it is at most
 * `LEAD_REVERT_WINDOW_MS` old. Each write stamps the lead's `updated_at` and
 * answers the whole lead, read after the commit. No note text is logged.
 */
@Injectable()
export class LeadEntriesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly leads: LeadsService,
  ) {}

  /** Adds a note written by the caller. Check order: malformed lead id,
   *  `LEAD_NOTE_EMPTY`, `LEAD_NOTE_TOO_LONG`, unknown lead. */
  async addNote(
    leadId: string,
    caller: LeadCaller,
    body: unknown,
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    const noteBody = normalizeNoteBody(noteTextOf(body));
    await this.runNoteWrite(async (manager) => {
      const lockedLeadId = await this.lockLead(manager, leadId);
      await manager.save(
        LeadEntry,
        manager.create(LeadEntry, {
          leadId: lockedLeadId,
          kind: 'note',
          body: noteBody,
          authorId: caller.userId,
        }),
      );
      await manager.query(TOUCH_LEAD_SQL, [lockedLeadId]);
    });
    return this.leads.getLead(leadId, caller);
  }

  /** Rewrites a note's text and stamps `edited_at`. Check order: malformed
   *  lead id, malformed entry id, `LEAD_NOTE_EMPTY`, `LEAD_NOTE_TOO_LONG`,
   *  unknown lead, entry missing from this lead, `LEAD_ENTRY_NOT_EDITABLE`,
   *  `LEAD_NOTE_NOT_YOURS`. The same text is a no-op: nothing is stamped. */
  async editNote(
    leadId: string,
    entryId: string,
    caller: LeadCaller,
    body: unknown,
  ): Promise<LeadDTO> {
    this.assertIdShapes(leadId, entryId);
    const noteBody = normalizeNoteBody(noteTextOf(body));
    await this.runNoteWrite(async (manager) => {
      const note = await this.findEditableNote(
        manager,
        leadId,
        entryId,
        caller,
      );
      if (note.body === noteBody) {
        return;
      }
      await manager.update(LeadEntry, note.id, {
        body: noteBody,
        editedAt: () => 'now()',
      });
      await manager.query(TOUCH_LEAD_SQL, [note.leadId]);
    });
    return this.leads.getLead(leadId, caller);
  }

  /** Deletes a note. The edit check order without the text checks. */
  async deleteNote(
    leadId: string,
    entryId: string,
    caller: LeadCaller,
  ): Promise<LeadDTO> {
    this.assertIdShapes(leadId, entryId);
    await this.runNoteWrite(async (manager) => {
      const note = await this.findEditableNote(
        manager,
        leadId,
        entryId,
        caller,
      );
      await manager.delete(LeadEntry, { id: note.id });
      await manager.query(TOUCH_LEAD_SQL, [note.leadId]);
    });
    return this.leads.getLead(leadId, caller);
  }

  /**
   * Reverts a stage change: sets the lead back to the entry's `fromStage`,
   * deletes the entry and stamps the lead's `updated_at`. The revert writes
   * no entry of its own, so the log reads as if the change never happened.
   * Check order: malformed lead id (`LEAD_NOT_FOUND`), malformed entry id
   * (`LEAD_ENTRY_NOT_FOUND`), then inside one transaction with the leads
   * table lock and the lead row lock: unknown lead (`LEAD_NOT_FOUND`), entry
   * missing from this lead (`LEAD_ENTRY_NOT_FOUND`), then
   * `LEAD_ENTRY_NOT_REVERTIBLE` with `reason` `not_stage_change`,
   * `not_newest`, `stage_moved`, `not_yours`, `too_old`. An entry exactly
   * `LEAD_REVERT_WINDOW_MS` old is still revertible. Two reverts of one entry
   * queue on the table lock, and the second finds the entry gone and answers
   * `LEAD_ENTRY_NOT_FOUND`.
   */
  async revertStageChange(
    leadId: string,
    entryId: string,
    caller: LeadCaller,
    now: Date = new Date(),
  ): Promise<LeadDTO> {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    if (!isUUID(entryId)) {
      throw leadError('LEAD_ENTRY_NOT_FOUND');
    }
    await this.runNoteWrite(async (manager) => {
      const lead = await this.lockLeadRow(manager, leadId, {
        id: true,
        stage: true,
      });
      const entry = await manager.findOne(LeadEntry, {
        where: { id: entryId, leadId: lead.id },
      });
      if (!entry) {
        throw leadError('LEAD_ENTRY_NOT_FOUND');
      }
      const fromStage = entry.fromStage;
      if (entry.kind !== 'stage_changed' || fromStage === null) {
        throw revertRefusal('not_stage_change');
      }
      const newestStageChange = await manager.findOne(LeadEntry, {
        where: { leadId: lead.id, kind: 'stage_changed' },
        select: { id: true },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      if (newestStageChange?.id !== entry.id) {
        throw revertRefusal('not_newest');
      }
      if (lead.stage !== entry.toStage) {
        throw revertRefusal('stage_moved');
      }
      if (!canRevertLeadEntry(entry, caller)) {
        throw revertRefusal('not_yours');
      }
      const entryAgeMs = now.getTime() - entry.createdAt.getTime();
      if (entryAgeMs > LEAD_REVERT_WINDOW_MS) {
        throw revertRefusal('too_old');
      }
      await manager.delete(LeadEntry, { id: entry.id });
      await manager.update(Lead, lead.id, {
        stage: fromStage,
        updatedAt: () => 'now()',
      });
    });
    return this.leads.getLead(leadId, caller, now);
  }

  /** A malformed lead id answers `LEAD_NOT_FOUND`, then a malformed entry id
   *  answers `LEAD_NOTE_NOT_FOUND`, before any query. */
  private assertIdShapes(leadId: string, entryId: string): void {
    if (!isUUID(leadId)) {
      throw leadError('LEAD_NOT_FOUND');
    }
    if (!isUUID(entryId)) {
      throw leadError('LEAD_NOTE_NOT_FOUND');
    }
  }

  /** Takes the leads table lock, then locks the lead row for the rest of
   *  the transaction and answers its id, or throws `LEAD_NOT_FOUND`. The
   *  table lock comes first, as in every lead write, so a note write and a
   *  lead update queue in one order: the note's later `TOUCH_LEAD_SQL` can
   *  then never wait on an update that waits on this row. */
  private async lockLead(
    manager: EntityManager,
    leadId: string,
  ): Promise<string> {
    const lead = await this.lockLeadRow(manager, leadId, { id: true });
    return lead.id;
  }

  /** `lockLead` reading the given columns of the locked row, so a revert
   *  reads the lead's stage under the same lock. */
  private async lockLeadRow(
    manager: EntityManager,
    leadId: string,
    select: FindOptionsSelect<Lead>,
  ): Promise<Lead> {
    await manager.query(LOCK_LEADS_SQL);
    const lead = await manager.findOne(Lead, {
      where: { id: leadId },
      select,
      lock: { mode: 'pessimistic_write' },
    });
    if (!lead) {
      throw leadError('LEAD_NOT_FOUND');
    }
    return lead;
  }

  /** The note the caller may change, in the contract order: the lead
   *  exists, the entry sits on it, the entry is a note, and the caller
   *  wrote it or is an Admin. */
  private async findEditableNote(
    manager: EntityManager,
    leadId: string,
    entryId: string,
    caller: LeadCaller,
  ): Promise<LeadEntry> {
    const lockedLeadId = await this.lockLead(manager, leadId);
    const entry = await manager.findOne(LeadEntry, {
      where: { id: entryId, leadId: lockedLeadId },
    });
    if (!entry) {
      throw leadError('LEAD_NOTE_NOT_FOUND');
    }
    if (entry.kind !== 'note') {
      throw leadError('LEAD_ENTRY_NOT_EDITABLE');
    }
    if (!canEditLeadEntry(entry, caller)) {
      throw leadError('LEAD_NOTE_NOT_YOURS');
    }
    return entry;
  }

  /** Runs one note write in a transaction. A CHECK that fires answers its
   *  note code, so no driver error carrying note text leaves the service;
   *  any other error is rethrown unchanged. */
  private async runNoteWrite(
    work: (manager: EntityManager) => Promise<void>,
  ): Promise<void> {
    try {
      await this.dataSource.transaction(work);
    } catch (error) {
      const refusal = leadCheckRefusal(error);
      if (refusal) {
        throw refusal;
      }
      throw error;
    }
  }
}
