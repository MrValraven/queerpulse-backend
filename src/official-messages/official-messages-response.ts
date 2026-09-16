import { initialsFor } from '../admin-communities/admin-communities-response';
import { toVisibleAvatarUrl } from '../common/member-ref';
import {
  OfficialBroadcast,
  OfficialBroadcastStatus,
} from './entities/official-broadcast.entity';

/** One row of `GET /admin/official-messages/broadcasts`. */
export interface OfficialBroadcastResponse {
  id: string;
  body: string;
  actorId: string | null;
  /** Display name of the admin who sent it; null once that account is erased. */
  actorName: string | null;
  status: OfficialBroadcastStatus;
  recipientCount: number;
  deliveredCount: number;
  createdAt: string;
  completedAt: string | null;
}

export function toOfficialBroadcastResponse(
  broadcast: OfficialBroadcast,
  actorName: string | null,
): OfficialBroadcastResponse {
  return {
    id: broadcast.id,
    body: broadcast.body,
    actorId: broadcast.actorId,
    actorName,
    status: broadcast.status,
    recipientCount: broadcast.recipientCount,
    deliveredCount: broadcast.deliveredCount,
    createdAt: broadcast.createdAt.toISOString(),
    completedAt: broadcast.completedAt?.toISOString() ?? null,
  };
}

/** `POST /admin/official-messages/members/:memberId` result. */
export interface OfficialMessageSentResponse {
  conversationId: string;
  messageId: string;
  recipientId: string;
  createdAt: string;
}

export function toOfficialMessageSentResponse(input: {
  conversationId: string;
  messageId: string;
  recipientId: string;
  createdAt: string;
}): OfficialMessageSentResponse {
  return {
    conversationId: input.conversationId,
    messageId: input.messageId,
    recipientId: input.recipientId,
    createdAt: input.createdAt,
  };
}

/** One row of `GET /admin/official-messages/recipients?q=`. */
export interface OfficialRecipientResponse {
  userId: string;
  slug: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
  /** `active` / `suspended` / `deactivated`: shown so an admin knows whether
   *  the member will see the message soon. */
  status: string;
}

export interface OfficialRecipientRow {
  user_id: string;
  slug: string;
  first_name: string;
  last_name: string;
  avatar_url: string | null;
  photo_visible: boolean;
  status: string;
}

export function toOfficialRecipientResponse(
  row: OfficialRecipientRow,
): OfficialRecipientResponse {
  const name = `${row.first_name} ${row.last_name}`.trim();
  return {
    userId: row.user_id,
    slug: row.slug,
    name,
    initials: initialsFor(name),
    // The "Show your photo" gate, through the one shared spelling every other
    // messaging read path uses. `toImageUrl` alone returned a face the member
    // had turned off.
    avatarUrl: toVisibleAvatarUrl({
      avatarUrl: row.avatar_url,
      photoVisible: row.photo_visible,
    }),
    status: row.status,
  };
}
