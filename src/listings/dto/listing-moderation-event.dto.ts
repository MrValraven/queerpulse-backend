import { MemberRef } from '../../common/member-ref';
import {
  ListingModerationAction,
  ListingModerationEvent,
} from '../entities/listing-moderation-event.entity';
import { ListingStatus } from '../entities/listing.entity';

/** One row of the moderation audit trail (item #16), as returned by
 * `GET /admin/listings/:ref/history`. Manually mapped — never the raw
 * `ListingModerationEvent` entity. */
export interface ListingModerationEventDTO {
  id: string;
  action: ListingModerationAction;
  fromStatus: ListingStatus | null;
  toStatus: ListingStatus | null;
  reason: string | null;
  actor: MemberRef | null;
  createdAt: string;
}

export function toListingModerationEventDTO(
  event: ListingModerationEvent,
  actor: MemberRef | null,
): ListingModerationEventDTO {
  return {
    id: event.id,
    action: event.action,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: event.reason,
    actor,
    createdAt: event.createdAt.toISOString(),
  };
}
