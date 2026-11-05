import type { Repository } from 'typeorm';
import type { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  buildLeadAuditRow,
  LEAD_AUDIT_ACTIONS,
  writeLeadAudit,
  type LeadAuditEntry,
} from './lead-audit';

const ACTOR_ID = '1a2b3c4d-0000-4000-8000-000000000001';
const LEAD_ID = '1a2b3c4d-0000-4000-8000-000000000002';
const PERSONA_ID = '1a2b3c4d-0000-4000-8000-000000000003';

function expectedRow(action: string, note: string): Partial<ModAuditLog> {
  return {
    reportId: null,
    actorId: ACTOR_ID,
    action,
    targetUserId: null,
    targetName: null,
    reasonCode: null,
    duration: null,
    note,
  };
}

describe('lead audit rows', () => {
  it('writes ids only for a link', () => {
    expect(
      buildLeadAuditRow({
        actorId: ACTOR_ID,
        action: 'lead_persona_linked',
        leadId: LEAD_ID,
        subprofileId: PERSONA_ID,
      }),
    ).toEqual(
      expectedRow(
        'lead_persona_linked',
        `lead:${LEAD_ID} persona:${PERSONA_ID}`,
      ),
    );
  });

  it('names the unlinked persona on an unlink', () => {
    expect(
      buildLeadAuditRow({
        actorId: ACTOR_ID,
        action: LEAD_AUDIT_ACTIONS.personaUnlinked,
        leadId: LEAD_ID,
        subprofileId: PERSONA_ID,
      }),
    ).toEqual(
      expectedRow(
        'lead_persona_unlinked',
        `lead:${LEAD_ID} persona:${PERSONA_ID}`,
      ),
    );
  });

  it('writes only the lead id for a delete with no persona', () => {
    expect(
      buildLeadAuditRow({
        actorId: ACTOR_ID,
        action: LEAD_AUDIT_ACTIONS.deleted,
        leadId: LEAD_ID,
        subprofileId: null,
      }),
    ).toEqual(expectedRow('lead_deleted', `lead:${LEAD_ID}`));
    expect(
      buildLeadAuditRow({
        actorId: ACTOR_ID,
        action: LEAD_AUDIT_ACTIONS.deleted,
        leadId: LEAD_ID,
        subprofileId: PERSONA_ID,
      }),
    ).toEqual(
      expectedRow('lead_deleted', `lead:${LEAD_ID} persona:${PERSONA_ID}`),
    );
  });

  it('lowercases both ids', () => {
    expect(
      buildLeadAuditRow({
        actorId: ACTOR_ID,
        action: LEAD_AUDIT_ACTIONS.personaLinked,
        leadId: LEAD_ID.toUpperCase(),
        subprofileId: PERSONA_ID.toUpperCase(),
      }).note,
    ).toBe(`lead:${LEAD_ID} persona:${PERSONA_ID}`);
  });

  it('lists the three contract actions', () => {
    expect(LEAD_AUDIT_ACTIONS).toEqual({
      personaLinked: 'lead_persona_linked',
      personaUnlinked: 'lead_persona_unlinked',
      deleted: 'lead_deleted',
    });
  });

  it('saves one row through the repository', async () => {
    const createdRow = { id: 'audit-row' } as ModAuditLog;
    const create = jest.fn().mockReturnValue(createdRow);
    const save = jest.fn().mockResolvedValue(createdRow);
    const repository = { create, save } as unknown as Repository<ModAuditLog>;
    const entry: LeadAuditEntry = {
      actorId: ACTOR_ID,
      action: LEAD_AUDIT_ACTIONS.personaLinked,
      leadId: LEAD_ID,
      subprofileId: PERSONA_ID,
    };

    await writeLeadAudit(repository, entry);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(buildLeadAuditRow(entry));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(createdRow);
  });
});
