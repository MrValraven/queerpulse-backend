import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { presentActorIds } from '../common/nullable-actor';
import { Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import {
  PlatformSettings,
  PLATFORM_SETTINGS_ID,
} from './entities/platform-settings.entity';
import {
  PlatformSettingChangeDTO,
  toPlatformSettingChangeDTO,
} from './platform-settings-response';
import {
  PLATFORM_LOCKDOWN_ENABLED,
  PlatformLockdownEnabledEvent,
} from './platform-settings.events';

/**
 * How long a cached copy of the settings row is trusted.
 *
 * The app is currently single-replica, so the explicit bust in `update()`
 * makes a flag change effectively instant and this TTL never fires in
 * practice. It exists so the feature stays correct after any scale-out: an
 * in-process bust does not cross a process boundary, and a kill switch that
 * silently fails to kill on 1 of N replicas is worse than no kill switch. The
 * TTL bounds that staleness without a shared store.
 */
const CACHE_TTL_MS = 10_000;

/** Every field an admin may change. Drives both the write and the audit. */
export const TOGGLEABLE_KEYS = [
  'registrationEnabled',
  'joinRequestsEnabled',
  'lockdownEnabled',
  'lockdownAllowsModerators',
  'lockdownMessage',
  'registrationClosedMessage',
  'announcementEnabled',
  'announcementMessage',
] as const;

export type SettingKey = (typeof TOGGLEABLE_KEYS)[number];

function stringifyValue(
  value: boolean | string | null | undefined,
): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Message fields are `''` the moment an admin clears the textarea, and an empty
 * string is not a message — it would render as a blank maintenance screen. It
 * means "no message", which this schema spells `null`.
 */
function normaliseValue(
  value: boolean | string | null,
): boolean | string | null {
  return value === '' ? null : value;
}

/**
 * A per-caller copy of the settings row that is still a `PlatformSettings`.
 *
 * `Object.assign(new PlatformSettings(), row)` rather than a spread, because
 * callers receive this as the entity type and the prototype has to survive:
 * a plain object would satisfy the compiler and then fail any `instanceof`, and
 * would not be something TypeORM could be handed back.
 *
 * Shallow on purpose. The only reference-typed column is `announcementExpiresAt`
 * (a `Date`), and the risk being closed here is a caller ASSIGNING to a field
 * of what it received, not one reaching inside a Date to mutate it in place.
 * Cloning the Date as well would cost an allocation on every authenticated
 * request through `PlatformLockdownGuard` to defend against something nobody
 * writes by accident.
 */
function copyOf(row: PlatformSettings): PlatformSettings {
  return Object.assign(new PlatformSettings(), row);
}

@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private cached: PlatformSettings | null = null;
  private cachedAt = 0;

  constructor(
    @InjectRepository(PlatformSettings)
    private readonly settings: Repository<PlatformSettings>,
    @InjectRepository(PlatformSettingChange)
    private readonly changes: Repository<PlatformSettingChange>,
    // Only ever read to resolve an audit row's `actorId` to a display name.
    // Injected as the bare repository and wrapped in `MemberLookup` (a plain
    // class, not a provider) rather than depending on `ProfilesService`, so
    // this module keeps no edge to the profiles module: this service is a
    // dependency of the GLOBAL lockdown guard, and every module it pulls in
    // becomes a module that has to be constructible before any request can be
    // answered.
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly dataSource: DataSource,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * The settings row, cached for `CACHE_TTL_MS`. Called on every authenticated
   * HTTP request via `PlatformLockdownGuard`, so it must not hit Postgres each
   * time — `JwtStrategy.validate` already spends one query per request.
   *
   * The two database failure modes are handled DIFFERENTLY, on purpose:
   *
   * - A **missing row** is fail-closed and fatal. There is no last-known-good
   *   value to fall back to, and defaulting to "unlocked" would mean a database
   *   problem silently disables the kill switch — exactly when you need it.
   * - A **failing query** (connection blip, pool exhaustion) degrades to the
   *   last known good value when we have one. The alternative is letting a raw
   *   TypeORM error escape `PlatformLockdownGuard` and 500 every non-exempt
   *   route — including handlers that would never have touched the database —
   *   purely because a perfectly good cached copy aged past its TTL. With no
   *   cached copy we have nothing to serve, so the error propagates.
   *
   * Every return path hands back a COPY, never the cached instance itself
   * (ENG-44). What callers receive is an entity, and the ordinary thing to do
   * with an entity is assign to a field on it. Doing that to the shared
   * instance would rewrite the platform's lockdown state for every concurrent
   * request until the TTL lapsed, from a caller that never touched Postgres and
   * has no idea it changed anything. Nothing does it today; the point is that
   * nothing can.
   */
  async get(): Promise<PlatformSettings> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return copyOf(this.cached);
    }
    let row: PlatformSettings | null;
    try {
      row = await this.settings.findOne({
        where: { id: PLATFORM_SETTINGS_ID },
      });
    } catch (err) {
      if (this.cached) {
        this.logger.warn(
          `platform_settings read failed (${
            err instanceof Error ? err.message : 'unknown error'
          }); serving the last known good copy from ${new Date(
            this.cachedAt,
          ).toISOString()}`,
        );
        return copyOf(this.cached);
      }
      throw err;
    }
    if (!row) {
      // Fail-closed and fatal, but surface a stable client message through
      // Nest's exception layer (a raw `Error` would escape as an opaque 500).
      // The migration detail stays server-side in the log.
      this.logger.error(
        'platform_settings row is missing — the AddPlatformSettings1782800790000 migration has not run',
      );
      throw new ServiceUnavailableException('Service temporarily unavailable');
    }
    this.cached = row;
    this.cachedAt = Date.now();
    return copyOf(row);
  }

  /**
   * Applies a partial update and records one audit row per *changed* field,
   * both inside one transaction. Fields absent from the DTO, and fields whose
   * submitted value equals the stored value, are neither written nor audited —
   * an admin saving the form without touching anything should not produce
   * history.
   *
   * Emits {@link PLATFORM_LOCKDOWN_ENABLED} on a false -> true transition of
   * `lockdownEnabled` only, so live WebSockets can be dropped (see the event's
   * doc comment). Not on every save, and not when lockdown was already on.
   */
  async update(
    dto: UpdatePlatformSettingsDto,
    actorId: string,
  ): Promise<PlatformSettings> {
    const { saved, lockdownJustEnabled } = await this.dataSource.transaction(
      async (manager) => {
        const current = await manager.findOneOrFail(PlatformSettings, {
          where: { id: PLATFORM_SETTINGS_ID },
        });
        // Read before the loop mutates `current` below.
        const wasLockedDown = current.lockdownEnabled;
        const previousAnnouncementMessage = current.announcementMessage;

        const auditRows: PlatformSettingChange[] = [];
        for (const key of TOGGLEABLE_KEYS) {
          const submitted = dto[key];
          if (submitted === undefined) {
            continue;
          }
          const next = normaliseValue(submitted);
          const previous = current[key];
          if (previous === next) {
            continue;
          }
          auditRows.push(
            manager.create(PlatformSettingChange, {
              actorId,
              settingKey: key,
              oldValue: stringifyValue(previous),
              newValue: stringifyValue(next),
              note: dto.note ?? null,
            }),
          );
          Object.assign(current, { [key]: next });
        }

        // `announcementExpiresAt` is a `Date` column, so it can't go through
        // the string/boolean loop above (`normaliseValue`/`stringifyValue`
        // assume primitive equality and `''` -> `null` collapsing, neither of
        // which applies to a Date). Handled here instead, audited the same
        // way as every other field.
        if (dto.announcementExpiresAt !== undefined) {
          const nextExpiresAt =
            dto.announcementExpiresAt === null
              ? null
              : new Date(dto.announcementExpiresAt);
          const previousExpiresAt = current.announcementExpiresAt;
          const previousIso = previousExpiresAt
            ? previousExpiresAt.toISOString()
            : null;
          const nextIso = nextExpiresAt ? nextExpiresAt.toISOString() : null;
          if (previousIso !== nextIso) {
            auditRows.push(
              manager.create(PlatformSettingChange, {
                actorId,
                settingKey: 'announcementExpiresAt',
                oldValue: previousIso,
                newValue: nextIso,
                note: dto.note ?? null,
              }),
            );
            current.announcementExpiresAt = nextExpiresAt;
          }
        }

        // Bump the announcement's version whenever its MESSAGE actually
        // changes, so a member who dismissed the old banner sees the new one.
        // Not on every save: toggling `announcementEnabled` off and back on
        // with the same message should not re-surface it for someone who
        // already dismissed it. Not audited as its own field — it is a
        // derived id, not something an admin directly sets.
        if (current.announcementMessage !== previousAnnouncementMessage) {
          current.announcementVersion = randomUUID();
        }

        if (auditRows.length === 0) {
          return { saved: current, lockdownJustEnabled: false };
        }

        current.updatedBy = actorId;
        const persisted = await manager.save(current);
        await manager.save(auditRows);
        return {
          saved: persisted,
          lockdownJustEnabled: !wasLockedDown && current.lockdownEnabled,
        };
      },
    );

    // Bust only after the transaction commits: busting earlier would let a
    // concurrent read repopulate the cache from the pre-commit state.
    this.cached = null;
    this.cachedAt = 0;

    // Likewise emitted only after the commit and the bust: a listener that
    // re-reads the settings must not be able to observe the pre-commit state.
    if (lockdownJustEnabled) {
      this.events.emit(PLATFORM_LOCKDOWN_ENABLED, {
        actorId,
      } satisfies PlatformLockdownEnabledEvent);
    }

    return saved;
  }

  /**
   * Audit history, newest first, in the repo-wide `Paginated` envelope
   * (ENG-50). A bare array left an admin auditing "who turned lockdown on"
   * unable to tell a last page from a truncated one: 50 rows back could mean
   * 50 changes exist, or that the fifty-first is the one they were looking for.
   *
   * `createdAt` alone is not a total order, so it is not a safe sort key for
   * offset pagination: one PATCH that flips two switches writes both audit rows
   * inside one transaction, with `createdAt` defaulted from the same
   * statement timestamp. Postgres is then free to return those ties in either
   * order per query, which is exactly how a row appears on page 1 and page 2
   * and another appears on neither. `id` breaks the tie deterministically.
   *
   * `limit` is validated `>= 1` by `ListChangesQuery` and defaulted by the
   * controller, so the `page` derivation below cannot divide by zero.
   */
  async listChanges(
    limit: number,
    offset: number,
  ): Promise<Paginated<PlatformSettingChangeDTO>> {
    const [rows, total] = await this.changes.findAndCount({
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit,
      skip: offset,
    });

    const actorsByUserId = await this.actorsFor(rows);

    return {
      items: rows.map((row) => toPlatformSettingChangeDTO(row, actorsByUserId)),
      total,
      // `Paginated` speaks page/pageSize because that is how every other list
      // endpoint is queried, while this one's established contract (and the
      // admin client that already calls it) is limit/offset. Rather than break
      // that contract for the sake of the envelope's vocabulary, the two are
      // derived from it: `pageSize` IS the requested limit, and `page` is which
      // limit-sized window this offset lands in. A caller that pages by whole
      // limits, which is the only way anything here pages, sees exactly the
      // page numbers it expects.
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
    };
  }

  /**
   * One batched profile lookup for a whole page of audit rows, so the list
   * costs two queries however many rows it returns rather than one per row.
   *
   * `presentActorIds` drops the NULLs an erased admin leaves behind before they
   * can reach an `IN (...)` for a user that no longer exists.
   */
  private actorsFor(
    rows: PlatformSettingChange[],
  ): Promise<Map<string, MemberRef>> {
    return new MemberLookup(this.profiles).byUserIds(
      presentActorIds(rows.map((row) => row.actorId)),
    );
  }
}
