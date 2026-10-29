import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { toStoredPlainTextOrNull } from '../communities/community-plain-text';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { DeclineStudioPurchaseDto } from './dto/decline-studio-purchase.dto';
import { StudioPurchaseStatus } from './entities/studio-purchase.entity';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';
import { StudioOwnershipService } from './studio-ownership.service';
import { toStudioPlaylistPerson } from './studio-playlist-response';
import {
  PURCHASE_ROW_SELECT_SQL,
  PurchaseRow,
  toStudioPurchaseItem,
} from './studio-purchase-rows';
import { STUDIO_PURCHASE_LIMITS } from './studio-purchase-rules';
import {
  STUDIO_PURCHASE_CONFIRMED,
  STUDIO_PURCHASE_DECLINED,
  StudioPurchaseEvent,
} from './studio-purchase.events';
import {
  StudioSalesPendingCount,
  StudioSalesTotals,
  StudioSellerPurchase,
} from './studio-purchases-response';
import { StudioPage } from './studio-response';
import { studioError } from './studio.constants';

/** Contract 4.2: the row lock every move out of `pending` takes first. */
export const LOCK_PURCHASE_SQL = `SELECT "id", "subprofile_id", "status" FROM "studio_purchases" WHERE "id" = $1 FOR UPDATE`;

/**
 * Contract 3.8, "To confirm". `$1` the persona, `$2`/`$3` the cursor or two
 * nulls, `$4` the page size plus one. Pending rows, oldest first, on
 * `IDX_studio_purchases_subprofile_status_created_at`.
 */
export const TO_CONFIRM_SQL = `${PURCHASE_ROW_SELECT_SQL}
 WHERE "purchase"."subprofile_id" = $1::uuid
   AND "purchase"."status" = 'pending'
   AND ($2::timestamptz IS NULL
     OR ("purchase"."created_at", "purchase"."id") > ($2::timestamptz, $3::uuid))
 ORDER BY "purchase"."created_at" ASC, "purchase"."id" ASC
 LIMIT $4`;

/**
 * Contract 3.10, sales. `$1` the persona, `$2`/`$3` the cursor or two nulls,
 * `$4` the page size plus one. Confirmed rows, newest decision first, on
 * `IDX_studio_purchases_subprofile_decided_at`.
 */
export const SALES_SQL = `${PURCHASE_ROW_SELECT_SQL}
 WHERE "purchase"."subprofile_id" = $1::uuid
   AND "purchase"."status" = 'confirmed'
   AND ($2::timestamptz IS NULL
     OR ("purchase"."decided_at", "purchase"."id") < ($2::timestamptz, $3::uuid))
 ORDER BY "purchase"."decided_at" DESC, "purchase"."id" DESC
 LIMIT $4`;

const SALES_WINDOW_SQL = `"purchase"."decided_at" >= now() - interval '${STUDIO_PURCHASE_LIMITS.salesWindowDays} days'`;

/**
 * Contract 3.10, totals. `$1` the persona. Confirmed rows only, unfloored
 * (the artist's own records). The sums are `bigint` and arrive as strings.
 */
export const SALES_TOTALS_SQL = `SELECT COALESCE(sum("purchase"."amount_cents") FILTER (WHERE ${SALES_WINDOW_SQL}), 0) AS "last_amount",
       (count(*) FILTER (WHERE ${SALES_WINDOW_SQL}))::int AS "last_count",
       COALESCE(sum("purchase"."amount_cents"), 0) AS "all_amount",
       count(*)::int AS "all_count"
  FROM "studio_purchases" "purchase"
 WHERE "purchase"."subprofile_id" = $1::uuid
   AND "purchase"."status" = 'confirmed'`;

/**
 * Contract 3.11. `$1` the caller. One row per persona the caller is a member
 * of (`subprofile_members`) with at least one pending claim.
 */
export const PENDING_COUNT_SQL = `SELECT "purchase"."subprofile_id" AS "subprofile_id",
       count(*)::int AS "count"
  FROM "studio_purchases" "purchase"
  INNER JOIN "subprofile_members" "member" ON "member"."subprofile_id" = "purchase"."subprofile_id"
 WHERE "member"."user_id" = $1::uuid
   AND "purchase"."status" = 'pending'
 GROUP BY "purchase"."subprofile_id"
 ORDER BY "purchase"."subprofile_id" ASC`;

/** Contract 3.9, confirm. `$1` the purchase, `$2` the deciding member. */
export const CONFIRM_PURCHASE_SQL = `UPDATE "studio_purchases"
   SET "status" = 'confirmed',
       "decided_at" = now(),
       "decided_by_user_id" = $2::uuid,
       "updated_at" = now()
 WHERE "id" = $1::uuid`;

/** Contract 3.9, decline. `$1` the purchase, `$2` the deciding member, `$3`
 *  the reason, `$4` the plain-text note or null. */
export const DECLINE_PURCHASE_SQL = `UPDATE "studio_purchases"
   SET "status" = 'declined',
       "decided_at" = now(),
       "decided_by_user_id" = $2::uuid,
       "decline_reason" = $3::studio_purchase_decline_reason,
       "decline_note" = $4,
       "updated_at" = now()
 WHERE "id" = $1::uuid`;

interface LockedPurchaseRow {
  id: string;
  subprofile_id: string | null;
  status: StudioPurchaseStatus;
}

interface SalesTotalsRow {
  last_amount: string | number;
  last_count: string | number;
  all_amount: string | number;
  all_count: string | number;
}

interface PendingCountRow {
  subprofile_id: string;
  count: string | number;
}

/**
 * The artist side of Studio purchases (contract 3.8 to 3.11 and 4.2). Every
 * owner route answers `studio_persona_not_found` to a caller who is no
 * member of the persona, before anything else is read. The inbox shows every
 * pending claim of the persona, across later blocks, so a payment someone
 * made stays answerable. Each decision runs in one transaction: the row lock
 * first, then the status check under that lock, so the second of two members
 * deciding at once (or a decision racing the buyer's cancel or the expiry
 * run) answers `studio_purchase_not_pending`. The event is emitted once the
 * transaction has committed.
 */
@Injectable()
export class StudioSalesService {
  private readonly memberLookup: MemberLookup;

  constructor(
    private readonly dataSource: DataSource,
    private readonly ownership: StudioOwnershipService,
    @InjectRepository(Profile) profiles: Repository<Profile>,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.memberLookup = new MemberLookup(profiles);
  }

  /** Contract 3.8: pending claims, oldest first. */
  async listToConfirm(
    userId: string,
    subprofileId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioSellerPurchase>> {
    await this.assertMember(userId, subprofileId);
    const pageSize = STUDIO_PURCHASE_LIMITS.inboxPerPage;
    const rows: PurchaseRow[] = await this.dataSource.query(TO_CONFIRM_SQL, [
      subprofileId,
      ...keysetCursorParameters(cursor),
      pageSize + 1,
    ]);
    return toKeysetPage(
      rows,
      pageSize,
      (row) => ({ publishedAt: row.created_at, id: row.id }),
      (pageRows) => this.toSellerPurchases(pageRows),
    );
  }

  /** Contract 3.10: confirmed sales, newest decision first. */
  async listSales(
    userId: string,
    subprofileId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioSellerPurchase>> {
    await this.assertMember(userId, subprofileId);
    const pageSize = STUDIO_PURCHASE_LIMITS.salesPerPage;
    const rows: PurchaseRow[] = await this.dataSource.query(SALES_SQL, [
      subprofileId,
      ...keysetCursorParameters(cursor),
      pageSize + 1,
    ]);
    return toKeysetPage(
      rows,
      pageSize,
      // A confirmed row always holds `decided_at` (CHK_studio_purchases_decided).
      (row) => ({ publishedAt: row.decided_at ?? row.created_at, id: row.id }),
      (pageRows) => this.toSellerPurchases(pageRows),
    );
  }

  /** Contract 3.10: the last 28 days and all time, confirmed rows only. */
  async totals(
    userId: string,
    subprofileId: string,
  ): Promise<StudioSalesTotals> {
    await this.assertMember(userId, subprofileId);
    const [row]: SalesTotalsRow[] = await this.dataSource.query(
      SALES_TOTALS_SQL,
      [subprofileId],
    );
    return {
      last28Days: {
        amountCents: Number(row?.last_amount ?? 0),
        count: Number(row?.last_count ?? 0),
      },
      allTime: {
        amountCents: Number(row?.all_amount ?? 0),
        count: Number(row?.all_count ?? 0),
      },
    };
  }

  /** Contract 3.11: pending claims on every persona the caller is a member
   *  of. */
  async pendingCount(userId: string): Promise<StudioSalesPendingCount> {
    const rows: PendingCountRow[] = await this.dataSource.query(
      PENDING_COUNT_SQL,
      [userId],
    );
    const byPersona = rows
      .map((row) => ({
        subprofileId: row.subprofile_id,
        count: Number(row.count),
      }))
      .filter((persona) => persona.count > 0);
    return {
      count: byPersona.reduce((total, persona) => total + persona.count, 0),
      byPersona,
    };
  }

  /** Contract 3.9: the payment arrived. */
  async confirm(
    userId: string,
    subprofileId: string,
    purchaseId: string,
  ): Promise<void> {
    await this.assertMember(userId, subprofileId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockPendingPurchase(manager, subprofileId, purchaseId);
      await manager.query(CONFIRM_PURCHASE_SQL, [purchaseId, userId]);
    });
    const event: StudioPurchaseEvent = { purchaseId };
    this.eventEmitter.emit(STUDIO_PURCHASE_CONFIRMED, event);
  }

  /** Contract 3.9: the claim is declined with a reason and an optional
   *  plain-text note (an empty note stores null). */
  async decline(
    userId: string,
    subprofileId: string,
    purchaseId: string,
    body: DeclineStudioPurchaseDto,
  ): Promise<void> {
    await this.assertMember(userId, subprofileId);
    await this.dataSource.transaction(async (manager) => {
      await this.lockPendingPurchase(manager, subprofileId, purchaseId);
      await manager.query(DECLINE_PURCHASE_SQL, [
        purchaseId,
        userId,
        body.reason,
        toStoredPlainTextOrNull(body.note),
      ]);
    });
    const event: StudioPurchaseEvent = { purchaseId };
    this.eventEmitter.emit(STUDIO_PURCHASE_DECLINED, event);
  }

  private async assertMember(
    userId: string,
    subprofileId: string,
  ): Promise<void> {
    if (!(await this.ownership.isPersonaMember(userId, subprofileId))) {
      throw studioError('studio_persona_not_found');
    }
  }

  /** Contract 4.2: locks the row, then checks it under the lock. */
  private async lockPendingPurchase(
    manager: EntityManager,
    subprofileId: string,
    purchaseId: string,
  ): Promise<void> {
    const [locked]: LockedPurchaseRow[] = await manager.query(
      LOCK_PURCHASE_SQL,
      [purchaseId],
    );
    if (!locked || locked.subprofile_id !== subprofileId) {
      throw studioError('studio_purchase_not_found');
    }
    if (locked.status !== StudioPurchaseStatus.Pending) {
      throw studioError('studio_purchase_not_pending');
    }
  }

  /** The buyer is always the account (one batched profile read); a null
   *  buyer is a deleted account. */
  private async toSellerPurchases(
    rows: PurchaseRow[],
  ): Promise<StudioSellerPurchase[]> {
    const buyerUserIds = [
      ...new Set(
        rows.flatMap((row) =>
          row.buyer_user_id === null ? [] : [row.buyer_user_id],
        ),
      ),
    ];
    const membersByUserId = await this.memberLookup.byUserIds(buyerUserIds);
    return rows.map((row) => ({
      id: row.id,
      status: row.status,
      item: toStudioPurchaseItem(row),
      amountCents: row.amount_cents,
      referenceCode: row.reference_code,
      payerName: row.payer_name,
      buyer:
        row.buyer_user_id === null
          ? null
          : toStudioPlaylistPerson(membersByUserId.get(row.buyer_user_id)),
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at ? row.decided_at.toISOString() : null,
    }));
  }
}
