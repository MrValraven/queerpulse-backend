import { Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { normalizeNoteBody } from './lead-input';
import {
  canEditLeadEntry,
  type LeadCaller,
  type LeadDTO,
} from './lead-response';
import { leadError } from './leads.constants';
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

/**
 * Leads: the notes on a lead's entry log (add, edit, delete). Every refusal
 * goes through `leadError` in the contract's check order: the id shapes and
 * the note text are checked before any query, then the lead and the entry
 * are read inside the write's transaction with the lead row locked. Only
 * notes change, and only their author or an Admin changes them. Each write
 * stamps the lead's `updated_at` and answers the whole lead, read after the
 * commit. No note text is logged.
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
