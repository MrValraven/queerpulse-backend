import { MemberRef } from '../common/member-ref';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import { PlatformSettings } from './entities/platform-settings.entity';

/**
 * Response shapes for the admin platform-settings surface, hand-mapped like
 * every other domain rather than handed out as the entity (ENG-43).
 *
 * The three handlers under `/admin/platform-settings` used to return their
 * TypeORM rows directly. That reads as harmless on an admin-only endpoint, and
 * it is the one thing this table cannot afford: it is the highest-blast-radius
 * record in the product, and a passthrough means every column a future
 * migration adds ships to the client on the next deploy with nobody having
 * decided that it should. An explicit interface plus an explicit mapper makes
 * adding a field a choice someone has to make in this file.
 *
 * Each field below says why it is IN or OUT, so the next person adding a
 * column knows what the decision looked like the last time it was made.
 */

/**
 * `GET /admin/platform-settings`, and the `PATCH` that answers with the same
 * shape so the admin form can re-render from the save's own response.
 *
 * Two columns are deliberately OUT:
 *
 * - `id` is always `PLATFORM_SETTINGS_ID`. The table carries a CHECK (id = 1)
 *   constraint, so a constant that can never differ tells a client nothing,
 *   and shipping it invites addressing the row by id, which is the habit that
 *   eventually produces a second settings row.
 * - `updatedBy` is a raw account uuid that nothing on the admin screen
 *   renders. "Who changed what, and when" is answered properly by the change
 *   list below, where the actor is resolved to a display-safe `MemberRef`
 *   instead of a uuid a human cannot read.
 *
 * `updatedAt` stays IN: it is the only "how fresh is this state" signal an
 * admin gets while deciding whether a kill switch has already been flipped by
 * someone else, and unlike `updatedBy` it names no person.
 */
export interface PlatformSettingsDTO {
  /** Gates creation of new `User` rows. Returning users are unaffected. */
  registrationEnabled: boolean;
  /** Gates `POST /join-requests`, the public "request an invite" form. */
  joinRequestsEnabled: boolean;
  /** The platform kill switch: blocks everyone except staff. */
  lockdownEnabled: boolean;
  /** Whether moderators count as staff for the switch above. */
  lockdownAllowsModerators: boolean;
  lockdownMessage: string | null;
  /** Shared by BOTH the registration and join-request closed states. */
  registrationClosedMessage: string | null;
  announcementEnabled: boolean;
  announcementMessage: string | null;
  /** ISO 8601, or `null` for no auto-hide. */
  announcementExpiresAt: string | null;
  /** Bumped to a fresh uuid whenever `announcementMessage` actually changes. */
  announcementVersion: string;
  /** ISO 8601. When the row was last written, by anyone. */
  updatedAt: string;
}

/**
 * One changed field of the audit trail. A single PATCH that flips two switches
 * produces two of these, because the unit of audit is the field.
 *
 * `actorId` is deliberately OUT, replaced by a resolved `actor`. The raw column
 * was being rendered verbatim by the admin History tab, which meant the screen
 * read "by 6f2c1a94-…" and answered nobody's question. `actor` is `null` for
 * both cases that produce no name: an erased account (the FK is
 * ON DELETE SET NULL precisely so the trail outlives the person) and an admin
 * with no profile row. The frontend already has the "a deleted admin" label for
 * that, so one null covers both.
 */
export interface PlatformSettingChangeDTO {
  /** The audit row's own id. A stable key for the list, and nothing else. */
  id: string;
  /** e.g. `lockdownEnabled`. One of `TOGGLEABLE_KEYS`. */
  settingKey: string;
  /** Stringified previous value; `null` when the field was previously unset. */
  oldValue: string | null;
  /** Stringified new value; `null` when the admin cleared the field. */
  newValue: string | null;
  /** The note the admin supplied with the change, when they supplied one. */
  note: string | null;
  /** ISO 8601. */
  createdAt: string;
  /** Who made the change, or `null` when there is no longer a name to give. */
  actor: MemberRef | null;
}

/** Maps the singleton settings row to its admin response shape. */
export function toPlatformSettingsDTO(
  settings: PlatformSettings,
): PlatformSettingsDTO {
  return {
    registrationEnabled: settings.registrationEnabled,
    joinRequestsEnabled: settings.joinRequestsEnabled,
    lockdownEnabled: settings.lockdownEnabled,
    lockdownAllowsModerators: settings.lockdownAllowsModerators,
    lockdownMessage: settings.lockdownMessage,
    registrationClosedMessage: settings.registrationClosedMessage,
    announcementEnabled: settings.announcementEnabled,
    announcementMessage: settings.announcementMessage,
    announcementExpiresAt: settings.announcementExpiresAt
      ? settings.announcementExpiresAt.toISOString()
      : null,
    announcementVersion: settings.announcementVersion,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

/**
 * Maps one audit row to its response shape.
 *
 * `actorsByUserId` is precomputed by the caller in a single batched profile
 * lookup for the whole page (see `PlatformSettingsService.listChanges`), which
 * keeps this a pure mapping function and keeps the list at two queries however
 * many rows it returns.
 */
export function toPlatformSettingChangeDTO(
  change: PlatformSettingChange,
  actorsByUserId: ReadonlyMap<string, MemberRef>,
): PlatformSettingChangeDTO {
  return {
    id: change.id,
    settingKey: change.settingKey,
    oldValue: change.oldValue,
    newValue: change.newValue,
    note: change.note,
    createdAt: change.createdAt.toISOString(),
    actor: change.actorId ? (actorsByUserId.get(change.actorId) ?? null) : null,
  };
}
