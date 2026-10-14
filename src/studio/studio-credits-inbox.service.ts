import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager } from 'typeorm';
import { toImageUrl } from '../common/image-url';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  StudioPersonaCredit,
  StudioPersonaCreditState,
} from './entities/studio-persona-credit.entity';
import {
  notBlockedEitherWaySql,
  personaColumnsFromRow,
  personaColumnsSql,
} from './studio-discovery-sql';
import {
  StudioCreditInbox,
  StudioCreditInboxRow,
  StudioCreditPendingCount,
  toStudioPersonaRef,
} from './studio-persona-credit-response';
import {
  STUDIO_CREDIT_ACCEPTED,
  StudioCreditAcceptedEvent,
} from './studio-persona-credit.events';
import {
  TRACK_RELEASE_PERSONA_SQL,
  applyReleaseSideRemoval,
} from './studio-persona-credits.service';
import { listenablePersonaSql } from './studio-visibility';
import {
  STUDIO_DISCOVERY_LIMITS,
  isStudioCreditRole,
  studioError,
} from './studio.constants';

const INBOX_COLUMNS_SQL = `"credit"."id" AS "id",
       "credit"."role" AS "role",
       "credit"."status"::text AS "status",
       "credit"."created_at" AS "created_at",
       "credit"."responded_at" AS "responded_at",
       ${personaColumnsSql('requesting', 'requesting')},
       ${listenablePersonaSql('requesting')} AS "requesting_is_public",
       ${personaColumnsSql('credited', 'credited')},
       ${listenablePersonaSql('credited')} AS "credited_is_public",
       "track"."id" AS "track_id",
       "track"."title" AS "track_title",
       "release"."id" AS "release_id",
       "release"."title" AS "release_title",
       "release"."cover_key" AS "release_cover_key"`;

/** A credit joined to both personas, its track and the track's release,
 *  under the aliases `credit`, `credited`, `requesting`, `track` and
 *  `release`. The inbox reads and `CREDIT_ALERT_SQL` share it. */
export const CREDIT_PERSONAS_RELEASE_FROM_SQL = `FROM "studio_persona_credits" "credit"
  INNER JOIN "subprofiles" "credited" ON "credited"."id" = "credit"."subprofile_id"
  INNER JOIN "subprofiles" "requesting" ON "requesting"."id" = "credit"."requested_by_subprofile_id"
  INNER JOIN "studio_tracks" "track" ON "track"."id" = "credit"."track_id"
  INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"`;

/** `$1` the viewer. Credits to every persona the viewer is a member of
 *  (creator or co-owner). */
const INBOX_FROM_SQL = `${CREDIT_PERSONAS_RELEASE_FROM_SQL}
  INNER JOIN "subprofile_members" "viewer_member"
     ON "viewer_member"."subprofile_id" = "credit"."subprofile_id"
    AND "viewer_member"."user_id" = $1`;

/** A row shows while the requesting persona is public and the release is
 *  not taken down. Every inbox read applies it. */
const INBOX_PUBLIC_SQL = `"release"."status" <> 'taken_down'
   AND ${listenablePersonaSql('requesting')}`;

/** `INBOX_PUBLIC_SQL` with the requesting member clear of blocks either way
 *  with the viewer. Pending requests, the badge and accept share it. The
 *  accepted section reads `INBOX_PUBLIC_SQL` alone, so the credited side can
 *  still find and remove an accepted credit after a block. */
const INBOX_VISIBLE_SQL = `${INBOX_PUBLIC_SQL}
   AND ${notBlockedEitherWaySql('$1', '"credit"."requested_by_user_id"', 'requester_block')}`;

/** `$1` the viewer, `$2` the limit. Pending, newest first. */
export const INBOX_REQUESTS_SQL = `SELECT ${INBOX_COLUMNS_SQL}
  ${INBOX_FROM_SQL}
 WHERE "credit"."status" = 'pending'
   AND ${INBOX_VISIBLE_SQL}
 ORDER BY "credit"."created_at" DESC, "credit"."id" DESC
 LIMIT $2`;

/** `$1` the viewer, `$2` the limit. Accepted, newest answer first. */
export const INBOX_ACCEPTED_SQL = `SELECT ${INBOX_COLUMNS_SQL}
  ${INBOX_FROM_SQL}
 WHERE "credit"."status" = 'accepted'
   AND ${INBOX_PUBLIC_SQL}
 ORDER BY "credit"."responded_at" DESC NULLS LAST, "credit"."id" DESC
 LIMIT $2`;

/** `$1` the viewer. The nav badge: pending rows under the list's filters. */
export const INBOX_PENDING_COUNT_SQL = `SELECT CAST(COUNT(*) AS int) AS "count"
  ${INBOX_FROM_SQL}
 WHERE "credit"."status" = 'pending'
   AND ${INBOX_VISIBLE_SQL}`;

/** `$1` the viewer, `$2` a credit. The row the viewer just answered, under
 *  the pending list's filters. */
export const INBOX_ROW_BY_ID_SQL = `SELECT ${INBOX_COLUMNS_SQL}
  ${INBOX_FROM_SQL}
 WHERE "credit"."id" = $2
   AND ${INBOX_VISIBLE_SQL}`;

/** `$1` the viewer, `$2` a credit. One row while the pending list would
 *  show the credit to the viewer; accept requires it. */
export const INBOX_CREDIT_VISIBLE_SQL = `SELECT 1 AS "found"
  ${INBOX_FROM_SQL}
 WHERE "credit"."id" = $2
   AND ${INBOX_VISIBLE_SQL}
 LIMIT 1`;

/** `$1` a track id. Locks the track's release row, the first lock every
 *  credit write takes (`lockReleaseForWrite` on the release side). */
export const LOCK_TRACK_RELEASE_SQL = `SELECT "release"."id" AS "release_id"
  FROM "studio_releases" "release"
 WHERE "release"."id" = (
   SELECT "track"."release_id" FROM "studio_tracks" "track" WHERE "track"."id" = $1
 )
 FOR UPDATE`;

export interface InboxRow extends Record<string, unknown> {
  id: string;
  role: string;
  status: string;
  created_at: Date;
  responded_at: Date | null;
  requesting_is_public: boolean;
  credited_is_public: boolean;
  track_id: string;
  track_title: string;
  release_id: string;
  release_title: string;
  release_cover_key: string | null;
}

/** One inbox row, or none for a role or status the inbox does not show. */
export function toCreditInboxRow(row: InboxRow): StudioCreditInboxRow[] {
  if (
    !isStudioCreditRole(row.role) ||
    (row.status !== 'pending' && row.status !== 'accepted')
  ) {
    return [];
  }
  return [
    {
      id: row.id,
      role: row.role,
      status: row.status,
      requestingPersona: toStudioPersonaRef(
        personaColumnsFromRow(row, 'requesting'),
        row.requesting_is_public,
      ),
      creditedPersona: toStudioPersonaRef(
        personaColumnsFromRow(row, 'credited'),
        row.credited_is_public,
      ),
      track: { id: row.track_id, title: row.track_title },
      release: {
        id: row.release_id,
        title: row.release_title,
        coverUrl: toImageUrl(row.release_cover_key),
      },
      createdAt: row.created_at.toISOString(),
      respondedAt: row.responded_at ? row.responded_at.toISOString() : null,
    },
  ];
}

/**
 * Studio discovery: persona credits from the credited side. Every member of
 * a credited persona reads its requests and accepted credits and answers
 * them; the requesting member is never named. Each answer locks the
 * release row and then the credit row, so two owners answering at once
 * resolve one after the other (the second gets 409
 * `studio_credit_not_pending`). A credit the caller sits on
 * neither side of answers 404 `studio_credit_not_found`, the same as a
 * missing one.
 */
@Injectable()
export class StudioCreditsInboxService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getInbox(viewerId: string): Promise<StudioCreditInbox> {
    const limit = STUDIO_DISCOVERY_LIMITS.creditInboxPerSection;
    const [requestRows, acceptedRows]: [InboxRow[], InboxRow[]] =
      await Promise.all([
        this.dataSource.query(INBOX_REQUESTS_SQL, [viewerId, limit]),
        this.dataSource.query(INBOX_ACCEPTED_SQL, [viewerId, limit]),
      ]);
    return {
      requests: requestRows.flatMap(toCreditInboxRow),
      accepted: acceptedRows.flatMap(toCreditInboxRow),
    };
  }

  async pendingCount(viewerId: string): Promise<StudioCreditPendingCount> {
    const [row]: { count: number }[] = await this.dataSource.query(
      INBOX_PENDING_COUNT_SQL,
      [viewerId],
    );
    return { count: row?.count ?? 0 };
  }

  async accept(
    viewerId: string,
    creditId: string,
  ): Promise<StudioCreditInboxRow> {
    const storedCreditId = await this.answer(
      viewerId,
      creditId,
      StudioPersonaCreditState.Accepted,
    );
    this.eventEmitter.emit(STUDIO_CREDIT_ACCEPTED, {
      creditId: storedCreditId,
      acceptingUserId: viewerId,
    } satisfies StudioCreditAcceptedEvent);
    // The accept has committed. A 404 here means the row left the visible
    // set after the commit (a block or a takedown in between).
    const rows: InboxRow[] = await this.dataSource.query(INBOX_ROW_BY_ID_SQL, [
      viewerId,
      storedCreditId,
    ]);
    const [row] = rows.flatMap(toCreditInboxRow);
    if (!row) {
      throw studioError('studio_credit_not_found');
    }
    return row;
  }

  async decline(viewerId: string, creditId: string): Promise<void> {
    await this.answer(viewerId, creditId, StudioPersonaCreditState.Declined);
  }

  async remove(viewerId: string, creditId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const credit = await this.lockCredit(manager, creditId);
      if (!credit) {
        throw studioError('studio_credit_not_found');
      }
      const [trackRow]: { release_subprofile_id: string }[] =
        await manager.query(TRACK_RELEASE_PERSONA_SQL, [credit.trackId]);
      const isReleaseSide = trackRow
        ? await this.isMemberOf(
            manager,
            viewerId,
            trackRow.release_subprofile_id,
          )
        : false;
      if (isReleaseSide) {
        // The release side removes as it does from the track editor.
        if (credit.requesterDismissedAt) {
          throw studioError('studio_credit_not_found');
        }
        await applyReleaseSideRemoval(manager, credit);
        return;
      }
      if (!(await this.isMemberOf(manager, viewerId, credit.subprofileId))) {
        throw studioError('studio_credit_not_found');
      }
      if (credit.status !== StudioPersonaCreditState.Accepted) {
        throw studioError('studio_credit_not_accepted');
      }
      await manager.delete(StudioPersonaCredit, { id: credit.id });
    });
  }

  // Accept and decline: open to any member of the credited persona, on a
  // pending row only. Accept also needs the row the pending list would show
  // (public requesting persona, live release, requester clear of blocks),
  // so it never publishes a credit the inbox hides; decline skips that
  // check, so a member who blocked the requester can still decline. Answers
  // the stored id.
  private async answer(
    viewerId: string,
    creditId: string,
    status:
      StudioPersonaCreditState.Accepted | StudioPersonaCreditState.Declined,
  ): Promise<string> {
    return this.dataSource.transaction(async (manager) => {
      const credit = await this.lockCredit(manager, creditId);
      if (
        !credit ||
        !(await this.isMemberOf(manager, viewerId, credit.subprofileId))
      ) {
        throw studioError('studio_credit_not_found');
      }
      if (
        status === StudioPersonaCreditState.Accepted &&
        !(await this.isVisibleInInbox(manager, viewerId, credit.id))
      ) {
        throw studioError('studio_credit_not_found');
      }
      if (credit.status !== StudioPersonaCreditState.Pending) {
        throw studioError('studio_credit_not_pending');
      }
      await manager.update(
        StudioPersonaCredit,
        { id: credit.id },
        { status, respondedAt: new Date() },
      );
      return credit.id;
    });
  }

  // Locks the credit's release row, then the credit row: the order
  // `StudioPersonaCreditsService.removeFromTrack` takes them, so the two
  // sides queue behind each other. A credit whose track moved between the
  // two reads (an unlink re-key, which also deletes the credit) reads as
  // missing.
  private async lockCredit(
    manager: EntityManager,
    creditId: string,
  ): Promise<StudioPersonaCredit | null> {
    const unlockedCredit = await manager.findOne(StudioPersonaCredit, {
      where: { id: creditId },
      select: { id: true, trackId: true },
    });
    if (!unlockedCredit) {
      return null;
    }
    await manager.query(LOCK_TRACK_RELEASE_SQL, [unlockedCredit.trackId]);
    const credit = await manager.findOne(StudioPersonaCredit, {
      where: { id: unlockedCredit.id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!credit || credit.trackId !== unlockedCredit.trackId) {
      return null;
    }
    return credit;
  }

  private async isVisibleInInbox(
    manager: EntityManager,
    viewerId: string,
    creditId: string,
  ): Promise<boolean> {
    const rows: { found: number }[] = await manager.query(
      INBOX_CREDIT_VISIBLE_SQL,
      [viewerId, creditId],
    );
    return rows.length > 0;
  }

  private isMemberOf(
    manager: EntityManager,
    userId: string,
    subprofileId: string,
  ): Promise<boolean> {
    return manager.exists(SubprofileMember, {
      where: { userId, subprofileId },
    });
  }
}
