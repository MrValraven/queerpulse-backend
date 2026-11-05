import type { EntityManager } from 'typeorm';

/**
 * Leads: the statement that drops a lead's link to the persona on unlink.
 * Keyed by the persona's (fresh) id, which the lead's foreign key carried
 * along with the row.
 */
export const FORGET_LEAD_LINK_SQL = `UPDATE "leads" SET "linked_subprofile_id" = NULL WHERE "linked_subprofile_id" = $1`;

/**
 * Leads: the statement that stops a lead's history naming the persona on
 * unlink. Keyed by the persona's (fresh) id, which each entry's foreign key
 * carried along with the row.
 */
export const FORGET_LEAD_ENTRY_PERSONA_SQL = `UPDATE "lead_entries" SET "subprofile_id" = NULL WHERE "subprofile_id" = $1`;

/**
 * Leads: what a persona unlink ends. The staff lead that pointed at the named
 * persona drops its link, and every entry of its history that named the
 * persona drops that reference, so the old link entries read as a persona
 * that is no longer available. A kept link would tie the pseudonymous persona
 * to the lead the named persona had.
 *
 * The unlink writes no entry and no audit row, and both statements are raw
 * SQL so `@UpdateDateColumn` never fires: a bumped `updated_at` would place
 * the unlink on the lead's timeline.
 *
 * The rekey's `ON UPDATE CASCADE` already takes ROW EXCLUSIVE on "leads", so
 * an unlink waits behind any lead write holding the leads table lock.
 *
 * Runs inside the unlink transaction, after the persona row has moved to its
 * fresh id (both `ON UPDATE CASCADE` keys carried the references along). A
 * plain function over the caller's `EntityManager`, like
 * `forgetWallPickOfPersona`, so the subprofiles module calls it with no
 * repository of its own.
 */
export async function forgetLeadLinkOfPersona(
  manager: EntityManager,
  freshSubprofileId: string,
): Promise<void> {
  await manager.query(FORGET_LEAD_LINK_SQL, [freshSubprofileId]);
  await manager.query(FORGET_LEAD_ENTRY_PERSONA_SQL, [freshSubprofileId]);
}
