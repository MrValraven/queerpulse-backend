import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ListingModerationEvent } from '../../listings/entities/listing-moderation-event.entity';
import { Listing } from '../../listings/entities/listing.entity';
import { User, UserRole } from '../../users/entities/user.entity';
import {
  applyPlatformLogWindow,
  compactParams,
  exactTimeSql,
  selectPlatformLogColumns,
} from '../platform-log-query';
import type {
  PlatformLogCategory,
  PlatformLogRawEntry,
  PlatformLogSource,
  SourceWindow,
} from '../platform-log.types';

/** Written with the owner, a co-manager or the accepting member as actor. */
const LISTING_MEMBER_ACTIONS: readonly string[] = [
  'answered',
  'owner_edited',
  'directory_paused',
  'directory_resumed',
  'co_manager_added',
];

/** Written by either side; classified by the actor's role. */
const LISTING_MIXED_ACTIONS: readonly string[] = [
  'co_manager_removed',
  'ownership_transferred',
];

const STAFF_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

interface ListingEventRow {
  row_id: string;
  occurred_at_exact: string;
  action: string;
  actor_id: string | null;
  from_status: string | null;
  to_status: string | null;
  reason: string | null;
  listing_name: string | null;
  listing_ref: string | null;
  actor_role: string | null;
}

@Injectable()
export class ListingModerationEventSource implements PlatformLogSource {
  readonly key = 'list';
  readonly categories: readonly PlatformLogCategory[] = ['reviews'];
  readonly audience = 'staff' as const;

  constructor(
    @InjectRepository(ListingModerationEvent)
    private readonly events: Repository<ListingModerationEvent>,
  ) {}

  async fetch(window: SourceWindow): Promise<PlatformLogRawEntry[]> {
    if (!window.categories.includes('reviews')) return [];
    const queryBuilder = selectPlatformLogColumns(
      this.events
        .createQueryBuilder('e')
        .leftJoin(Listing, 'l', '"l"."id" = "e"."listing_id"')
        .leftJoin(User, 'u', '"u"."id" = "e"."actor_id"'),
      {
        row_id: '"e"."id"',
        occurred_at_exact: exactTimeSql('"e"."created_at"'),
        action: '"e"."action"',
        actor_id: '"e"."actor_id"',
        from_status: '"e"."from_status"',
        to_status: '"e"."to_status"',
        reason: '"e"."reason"',
        listing_name: '"l"."name"',
        listing_ref: '"l"."ref"',
        actor_role: '"u"."role"',
      },
    );
    if (window.staffRowsOnly) {
      queryBuilder.andWhere(
        '("e"."action" NOT IN (:...listingMemberActions) AND ' +
          '("e"."action" NOT IN (:...listingMixedActions) OR "u"."role" IN (:...listingStaffRoles)))',
        {
          listingMemberActions: [...LISTING_MEMBER_ACTIONS],
          listingMixedActions: [...LISTING_MIXED_ACTIONS],
          listingStaffRoles: [...STAFF_ROLES],
        },
      );
    }
    if (window.memberId) {
      queryBuilder.andWhere('"e"."actor_id" = :memberId', {
        memberId: window.memberId,
      });
    }
    applyPlatformLogWindow(
      queryBuilder,
      this.key,
      { timeSql: '"e"."created_at"', idSql: '"e"."id"' },
      window,
    );
    const rows = await queryBuilder.getRawMany<ListingEventRow>();
    return rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: ListingEventRow): PlatformLogRawEntry {
    const isStaffActor =
      row.actor_role !== null && STAFF_ROLES.includes(row.actor_role);
    const isMemberRow =
      LISTING_MEMBER_ACTIONS.includes(row.action) ||
      (LISTING_MIXED_ACTIONS.includes(row.action) && !isStaffActor);
    return {
      sourceKey: this.key,
      rowId: row.row_id,
      occurredAtExact: row.occurred_at_exact,
      category: 'reviews',
      kind: `listing.${row.action}`,
      actorUserId: row.actor_id,
      actorFallbackName: null,
      actorKind: isMemberRow ? 'member' : 'staff',
      targetUserId: null,
      targetFallbackName: null,
      subject: {
        label: row.listing_name ?? '',
        route: row.listing_ref
          ? `/admin/listings?q=${encodeURIComponent(row.listing_ref)}`
          : '/admin/listings',
      },
      params: compactParams({
        fromStatus: row.from_status,
        toStatus: row.to_status,
      }),
      note: row.reason,
    };
  }
}
