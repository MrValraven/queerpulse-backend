import { Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, IsNull } from 'typeorm';
import { normalizeHandle } from '../common/handles';
import { CreateStudioPersonaCreditDto } from './dto/create-studio-persona-credit.dto';
import {
  StudioPersonaCredit,
  StudioPersonaCreditState,
} from './entities/studio-persona-credit.entity';
import { StudioReleaseStatus } from './entities/studio-release.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  PersonaColumns,
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import { StudioOwnershipService } from './studio-ownership.service';
import {
  OwnerCreditRow,
  StudioCreditCandidate,
  StudioPersonaCreditOwnerRow,
  toStudioPersonaCreditOwnerRow,
  toStudioPersonaRef,
} from './studio-persona-credit-response';
import {
  STUDIO_CREDIT_REQUESTED,
  StudioCreditRequestedEvent,
} from './studio-persona-credit.events';
import { listenablePersonaSql } from './studio-visibility';
import { STUDIO_DISCOVERY_LIMITS, studioError } from './studio.constants';

/** One leading `@` dropped, then `normalizeHandle` (trimmed, lowercased).
 *  Null when nothing is left or more than 60 characters are. */
export function normalizeCreditHandle(rawHandle: string): string | null {
  const trimmedHandle = rawHandle.trim();
  const handle = normalizeHandle(
    trimmedHandle.startsWith('@') ? trimmedHandle.slice(1) : trimmedHandle,
  );
  if (
    !handle ||
    handle.length > STUDIO_DISCOVERY_LIMITS.creditHandleMaxLength
  ) {
    return null;
  }
  return handle;
}

/**
 * What the release side's remove does to a credit: a pending or accepted
 * row is deleted, and a declined row is dismissed (`requester_dismissed_at`)
 * so it leaves the editor's list and still blocks a repeat request. Shared
 * by `DELETE /studio/tracks/:id/persona-credits/:creditId` and the release
 * side of `DELETE /studio/credits/:id`.
 */
export async function applyReleaseSideRemoval(
  manager: EntityManager,
  credit: Pick<StudioPersonaCredit, 'id' | 'status'>,
): Promise<void> {
  if (credit.status === StudioPersonaCreditState.Declined) {
    await manager.update(
      StudioPersonaCredit,
      { id: credit.id },
      { requesterDismissedAt: new Date() },
    );
    return;
  }
  await manager.delete(StudioPersonaCredit, { id: credit.id });
}

/**
 * `$1` the viewer, `$2` a normalized handle. The persona `/p/<handle>`
 * would show this viewer: published, open, present, holding the handle,
 * clear of moderator action (`listenablePersonaSql` is kind-agnostic), and
 * its creator clear of blocks either way. Exact match only; personas are
 * never searched, so none can be enumerated.
 */
export const CREDIT_CANDIDATE_SQL = `SELECT ${personaColumnsSql('persona', 'persona')}
  FROM "subprofiles" "persona"
 WHERE "persona"."handle" = $2
   AND ${listenablePersonaSql('persona')}
   AND ${notBlockedEitherWaySql('$1', '"persona"."user_id"', 'candidate_block')}
 LIMIT 1`;

/** `$1` a track, `$2` one credit id or null, `$3` the viewer. The editor's
 *  rows, dismissed declines left out, oldest first. `is_persona_public` is
 *  the persona rule alone; `is_persona_linkable` also needs the persona's
 *  creator clear of blocks with the viewer, so the chip never links to an
 *  artist page that answers this viewer 404. */
export const OWNER_CREDIT_ROWS_SQL = `SELECT "credit"."id" AS "id",
       "credit"."role" AS "role",
       "credit"."status"::text AS "status",
       "credit"."created_at" AS "created_at",
       ${personaColumnsSql('persona', 'persona')},
       ${listenablePersonaSql('persona')} AS "is_persona_public",
       (${listenablePersonaSql('persona')}
         AND ${notBlockedEitherWaySql('$3', '"persona"."user_id"', 'owner_row_block')}) AS "is_persona_linkable"
  FROM "studio_persona_credits" "credit"
  INNER JOIN "subprofiles" "persona" ON "persona"."id" = "credit"."subprofile_id"
 WHERE "credit"."track_id" = $1
   AND "credit"."requester_dismissed_at" IS NULL
   AND ($2::uuid IS NULL OR "credit"."id" = $2)
 ORDER BY "credit"."created_at" ASC, "credit"."id" ASC`;

/** `$1` a track id: the track's stored id and its release's persona, or no
 *  row. Task 12's track lookups read it too. */
export const TRACK_RELEASE_PERSONA_SQL = `SELECT "track"."id" AS "track_id",
       "release"."subprofile_id" AS "release_subprofile_id"
  FROM "studio_tracks" "track"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 WHERE "track"."id" = $1`;

interface TrackReleasePersonaRow {
  track_id: string;
  release_subprofile_id: string;
}

/**
 * Studio discovery: persona credits from the release side. Members of the
 * release's persona look a persona up by exact handle, request a credit in
 * a role, list their track's credits with each status, and remove them.
 * Every write runs under the release row lock
 * (`StudioOwnershipService.lockReleaseForWrite`), which also answers a
 * non-member 404 on a draft and 403 `studio_not_persona_owner` on a
 * published release, so the limit and repeat checks see every committed
 * request. A request is stored `pending` for every credited persona, the
 * member's own other personas included, and the alert goes out after the
 * commit.
 */
@Injectable()
export class StudioPersonaCreditsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async findCandidate(
    viewerId: string,
    rawHandle: string,
  ): Promise<StudioCreditCandidate> {
    const candidate = await this.resolveCandidate(
      this.dataSource.manager,
      viewerId,
      rawHandle,
    );
    if (!candidate) {
      throw studioError('studio_credit_candidate_not_found');
    }
    return toStudioPersonaRef(candidate, true);
  }

  async listForTrack(
    viewerId: string,
    trackId: string,
  ): Promise<{ items: StudioPersonaCreditOwnerRow[] }> {
    const [track]: TrackReleasePersonaRow[] = await this.dataSource.query(
      TRACK_RELEASE_PERSONA_SQL,
      [trackId],
    );
    if (
      !track ||
      !(await this.ownership.isPersonaMember(
        viewerId,
        track.release_subprofile_id,
      ))
    ) {
      throw new NotFoundException('Track not found');
    }
    const rows: OwnerCreditRow[] = await this.dataSource.query(
      OWNER_CREDIT_ROWS_SQL,
      [track.track_id, null, viewerId],
    );
    return { items: rows.flatMap(toStudioPersonaCreditOwnerRow) };
  }

  async create(
    viewerId: string,
    trackId: string,
    body: CreateStudioPersonaCreditDto,
  ): Promise<StudioPersonaCreditOwnerRow> {
    const { creditId, storedTrackId } = await this.dataSource.transaction(
      async (manager) => {
        const track = await manager.findOne(StudioTrack, {
          where: { id: trackId },
          select: { id: true, releaseId: true },
        });
        if (!track) {
          throw new NotFoundException('Track not found');
        }
        const { release } = await this.lockTrackReleaseForWrite(
          manager,
          viewerId,
          track.releaseId,
        );
        if (release.status === StudioReleaseStatus.TakenDown) {
          throw studioError('studio_release_not_draft');
        }
        const candidate = await this.resolveCandidate(
          manager,
          viewerId,
          body.handle,
        );
        if (!candidate) {
          throw studioError('studio_credit_persona_not_creditable');
        }
        if (candidate.id === release.subprofileId) {
          throw studioError('studio_credit_self_persona');
        }
        const isAlreadyRequested = await manager.exists(StudioPersonaCredit, {
          where: {
            trackId: track.id,
            subprofileId: candidate.id,
            role: body.role,
          },
        });
        if (isAlreadyRequested) {
          throw studioError('studio_credit_already_requested');
        }
        // A requester-dismissed decline leaves the limit; the repeat check
        // above still reads it, so the same persona and role stay blocked.
        const creditCount = await manager.count(StudioPersonaCredit, {
          where: { trackId: track.id, requesterDismissedAt: IsNull() },
        });
        if (creditCount >= STUDIO_DISCOVERY_LIMITS.personaCreditsPerTrack) {
          throw studioError('studio_credit_limit');
        }
        const saved = await manager.save(
          manager.create(StudioPersonaCredit, {
            trackId: track.id,
            subprofileId: candidate.id,
            role: body.role,
            status: StudioPersonaCreditState.Pending,
            requestedBySubprofileId: release.subprofileId,
            requestedByUserId: viewerId,
          }),
        );
        return { creditId: saved.id, storedTrackId: track.id };
      },
    );
    this.eventEmitter.emit(STUDIO_CREDIT_REQUESTED, {
      creditId,
      requestingUserId: viewerId,
    } satisfies StudioCreditRequestedEvent);
    const rows: OwnerCreditRow[] = await this.dataSource.manager.query(
      OWNER_CREDIT_ROWS_SQL,
      [storedTrackId, creditId, viewerId],
    );
    const [ownerRow] = rows.flatMap(toStudioPersonaCreditOwnerRow);
    if (!ownerRow) {
      throw studioError('studio_credit_not_found');
    }
    return ownerRow;
  }

  async removeFromTrack(
    viewerId: string,
    trackId: string,
    creditId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const track = await manager.findOne(StudioTrack, {
        where: { id: trackId },
        select: { id: true, releaseId: true },
      });
      if (!track) {
        throw new NotFoundException('Track not found');
      }
      await this.lockTrackReleaseForWrite(manager, viewerId, track.releaseId);
      const credit = await manager.findOne(StudioPersonaCredit, {
        where: { id: creditId, trackId: track.id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!credit || credit.requesterDismissedAt) {
        throw studioError('studio_credit_not_found');
      }
      await applyReleaseSideRemoval(manager, credit);
    });
  }

  // `lockReleaseForWrite` answers "Release not found" to a non-member. On a
  // track route that would tell an existing draft track from a missing one,
  // so its 404 is answered with the same "Track not found".
  private async lockTrackReleaseForWrite(
    manager: EntityManager,
    viewerId: string,
    releaseId: string,
  ): ReturnType<StudioOwnershipService['lockReleaseForWrite']> {
    try {
      return await this.ownership.lockReleaseForWrite(
        manager,
        viewerId,
        releaseId,
      );
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException('Track not found');
      }
      throw error;
    }
  }

  private async resolveCandidate(
    manager: EntityManager,
    viewerId: string,
    rawHandle: string,
  ): Promise<PersonaColumns | null> {
    const handle = normalizeCreditHandle(rawHandle);
    if (!handle) {
      return null;
    }
    const rows: Record<string, unknown>[] = await manager.query(
      CREDIT_CANDIDATE_SQL,
      [viewerId, handle],
    );
    const [candidateRow] = rows;
    return candidateRow ? personaColumnsFromRow(candidateRow, 'persona') : null;
  }
}
