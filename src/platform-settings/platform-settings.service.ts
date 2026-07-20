import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { PlatformSettingChange } from './entities/platform-setting-change.entity';
import {
  PlatformSettings,
  PLATFORM_SETTINGS_ID,
} from './entities/platform-settings.entity';
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
   */
  async get(): Promise<PlatformSettings> {
    if (this.cached && Date.now() - this.cachedAt < CACHE_TTL_MS) {
      return this.cached;
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
        return this.cached;
      }
      throw err;
    }
    if (!row) {
      throw new Error(
        'platform_settings row is missing — the AddPlatformSettings1782800790000 migration has not run',
      );
    }
    this.cached = row;
    this.cachedAt = Date.now();
    return row;
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

  /** Audit history, newest first. */
  listChanges(limit: number, offset: number): Promise<PlatformSettingChange[]> {
    return this.changes.find({
      order: { createdAt: 'DESC' },
      take: limit,
      skip: offset,
    });
  }
}
