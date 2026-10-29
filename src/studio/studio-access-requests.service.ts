import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isUUID } from 'class-validator';
import { DataSource, In, Repository } from 'typeorm';
import { MemberRef, toMemberRef } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import {
  StudioAccessGrantResponse,
  StudioAccessService,
} from './studio-access.service';
import {
  AccessRequestRow,
  AdminStudioAccessRequestPage,
  StudioAccessRequestState,
  decodeAccessRequestCursor,
  encodeAccessRequestCursor,
  toAdminStudioAccessRequest,
} from './studio-landing-response';
import { STUDIO_LIMITS, studioError } from './studio.constants';

/**
 * The rows Waiting for Studio shows (contract 12.3): the member is active and
 * holds no grant. A grant deletes the row in its own transaction, so the
 * second rule only covers a request filed in the moment a grant committed.
 */
const WAITING_REQUEST_FILTER_SQL = `"member"."status" = 'active'
  AND NOT EXISTS (SELECT 1 FROM "studio_access_grants" "grant" WHERE "grant"."user_id" = "request"."user_id")`;

/**
 * Files one request (contract 12.1). `$1` the member, `$2` wants_to_release.
 * The insert skips a member who holds a grant by the time it runs, so a grant
 * that commits after the access check leaves no request behind to resurface
 * after a later revoke. An empty result means a grant or a request exists.
 */
export const REQUEST_ACCESS_INSERT_SQL = `INSERT INTO "studio_access_requests" ("user_id", "wants_to_release")
  SELECT $1::uuid, $2::boolean
  WHERE NOT EXISTS (SELECT 1 FROM "studio_access_grants" WHERE "user_id" = $1::uuid)
  ON CONFLICT ("user_id") DO NOTHING
  RETURNING "created_at"`;

/**
 * Studio access requests (contract 12). A member asks for Studio access once
 * (`studio_access_requests` keeps one row per member) and may cancel; staff
 * read the waiting list artists first, then oldest, and grant or dismiss.
 * A grant goes through `StudioAccessService.grant`, which deletes the request
 * in the grant transaction and tells the member once the grant is new
 * (contract 12.4). A dismiss deletes the row quietly: no notification and no
 * message reach the member.
 */
@Injectable()
export class StudioAccessRequestsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    private readonly access: StudioAccessService,
  ) {}

  /**
   * Contract 12.1: files the caller's request. A member who holds a grant
   * reads 409 `studio_access_already_granted`; a second request reads 409
   * `studio_access_request_exists` (to change `wantsToRelease`, the member
   * cancels and asks again).
   */
  async requestAccess(
    userId: string,
    wantsToRelease: boolean,
  ): Promise<StudioAccessRequestState> {
    if (await this.access.hasAccess(userId)) {
      throw studioError('studio_access_already_granted');
    }
    const insertedRows: { created_at: Date }[] = await this.dataSource.query(
      REQUEST_ACCESS_INSERT_SQL,
      [userId, wantsToRelease],
    );
    const insertedRow = insertedRows.at(0);
    if (!insertedRow) {
      // A grant that landed after the first check also empties the insert.
      throw studioError(
        (await this.access.hasAccess(userId))
          ? 'studio_access_already_granted'
          : 'studio_access_request_exists',
      );
    }
    return {
      hasPendingRequest: true,
      wantsToRelease,
      requestedAt: insertedRow.created_at.toISOString(),
    };
  }

  /** Contract 12.1: `DELETE /studio/access-requests/me`, idempotent. */
  async cancelRequest(userId: string): Promise<void> {
    await this.dataSource.query(
      `DELETE FROM "studio_access_requests" WHERE "user_id" = $1`,
      [userId],
    );
  }

  /** Contract 12.2: the caller's waiting request for `GET /studio/me`, or null. */
  async findOwnRequest(
    userId: string,
  ): Promise<{ wantsToRelease: boolean; requestedAt: string } | null> {
    const rows: { wants_to_release: boolean; created_at: Date }[] =
      await this.dataSource.query(
        `SELECT "wants_to_release", "created_at" FROM "studio_access_requests" WHERE "user_id" = $1`,
        [userId],
      );
    const row = rows.at(0);
    return row
      ? {
          wantsToRelease: row.wants_to_release,
          requestedAt: row.created_at.toISOString(),
        }
      : null;
  }

  /**
   * Contract 12.3: one page of Waiting for Studio, artists first, then
   * oldest, `STUDIO_LIMITS.accessRequestsPageSize` rows a page. A malformed
   * cursor reads as the first page. `totalCount` and `artistCount` count every
   * waiting row under the same filter as the page.
   */
  async listWaiting(
    cursor: string | undefined,
  ): Promise<AdminStudioAccessRequestPage> {
    const position = decodeAccessRequestCursor(cursor);
    const pageSize = STUDIO_LIMITS.accessRequestsPageSize;
    const [rows, countRows] = await Promise.all([
      this.dataSource.query<AccessRequestRow[]>(
        `SELECT "request"."id", "request"."user_id", "request"."wants_to_release",
                "request"."is_from_invite", "request"."created_at"
           FROM "studio_access_requests" "request"
           INNER JOIN "users" "member" ON "member"."id" = "request"."user_id"
          WHERE ${WAITING_REQUEST_FILTER_SQL}
            AND ($1::boolean IS NULL
                 OR "request"."wants_to_release" < $1::boolean
                 OR ("request"."wants_to_release" = $1::boolean
                     AND ("request"."created_at", "request"."id") > ($2::timestamptz, $3::uuid)))
          ORDER BY "request"."wants_to_release" DESC, "request"."created_at" ASC, "request"."id" ASC
          LIMIT $4`,
        [
          position?.wantsToRelease ?? null,
          position?.createdAt ?? null,
          position?.id ?? null,
          pageSize + 1,
        ],
      ),
      this.dataSource.query<{ total_count: number; artist_count: number }[]>(
        `SELECT COUNT(*)::int AS "total_count",
                COUNT(*) FILTER (WHERE "request"."wants_to_release")::int AS "artist_count"
           FROM "studio_access_requests" "request"
           INNER JOIN "users" "member" ON "member"."id" = "request"."user_id"
          WHERE ${WAITING_REQUEST_FILTER_SQL}`,
      ),
    ]);
    const pageRows = rows.slice(0, pageSize);
    const lastRow = pageRows.at(-1);
    const hasMore = rows.length > pageSize;
    const memberRefs = await this.loadMemberRefs(
      pageRows.map((row) => row.user_id),
    );
    const counts = countRows.at(0);
    return {
      items: pageRows.map((row) =>
        toAdminStudioAccessRequest(row, memberRefs.get(row.user_id) ?? null),
      ),
      nextCursor:
        hasMore && lastRow
          ? encodeAccessRequestCursor({
              wantsToRelease: lastRow.wants_to_release,
              createdAt: lastRow.created_at,
              id: lastRow.id,
            })
          : null,
      totalCount: counts?.total_count ?? 0,
      artistCount: counts?.artist_count ?? 0,
    };
  }

  /**
   * Contract 12.3: grants the request's member through
   * `StudioAccessService.grant`, which deletes the request in the grant
   * transaction (contract 12.4). An unknown request reads 404
   * `studio_access_request_not_found`.
   */
  async grantRequest(
    staffUserId: string,
    requestId: string,
  ): Promise<StudioAccessGrantResponse> {
    if (!isUUID(requestId)) {
      throw studioError('studio_access_request_not_found');
    }
    const rows: { user_id: string }[] = await this.dataSource.query(
      `SELECT "user_id" FROM "studio_access_requests" WHERE "id" = $1`,
      [requestId],
    );
    const row = rows.at(0);
    if (!row) {
      throw studioError('studio_access_request_not_found');
    }
    return this.access.grant(staffUserId, row.user_id);
  }

  /** Contract 12.3: deletes the row quietly, idempotent; the member hears nothing. */
  async dismissRequest(requestId: string): Promise<void> {
    if (!isUUID(requestId)) {
      return;
    }
    await this.dataSource.query(
      `DELETE FROM "studio_access_requests" WHERE "id" = $1`,
      [requestId],
    );
  }

  /** One profile read for the page; `toMemberRef` honours `photoVisible`. */
  private async loadMemberRefs(
    userIds: string[],
  ): Promise<Map<string, MemberRef>> {
    const memberRefs = new Map<string, MemberRef>();
    if (userIds.length === 0) {
      return memberRefs;
    }
    const profiles = await this.profiles.find({
      where: { userId: In(userIds) },
    });
    for (const profile of profiles) {
      const memberRef = toMemberRef(profile);
      if (memberRef) {
        memberRefs.set(profile.userId, memberRef);
      }
    }
    return memberRefs;
  }
}
