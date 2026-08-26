import { MemberRef } from '../common/member-ref';
import type { CommunitySupportOption } from './community-support-options';
import {
  CommunitySupportOffer,
  CommunitySupportOfferStatus,
} from './entities/community-support-offer.entity';

/**
 * One offer of support, as both the community's mod-tools pane and the admin
 * console read it. Hand-mapped from the entity — there is no global serializer
 * in this repo, so every column that reaches a client is listed here on
 * purpose.
 *
 * `offeredBy` is the compact cross-domain `MemberRef`, `null` once the staff
 * member has erased their account (`offered_by_user_id` is `ON DELETE SET
 * NULL`) or has no profile row. `offeredByName` is the write-time snapshot the
 * reader falls back to in exactly that case, so the offer never becomes
 * anonymous. Neither raw user id is exposed: this module puts no user id in a
 * response.
 */
export interface CommunitySupportOfferDTO {
  id: string;
  options: CommunitySupportOption[];
  note: string | null;
  status: CommunitySupportOfferStatus;
  offeredBy: MemberRef | null;
  offeredByName: string | null;
  respondedBy: MemberRef | null;
  respondedAt: string | null;
  createdAt: string;
}

export function toCommunitySupportOfferDTO(
  offer: CommunitySupportOffer,
  offeredBy: MemberRef | null,
  respondedBy: MemberRef | null,
): CommunitySupportOfferDTO {
  return {
    id: offer.id,
    options: offer.options ?? [],
    note: offer.note,
    status: offer.status,
    offeredBy,
    offeredByName: offer.offeredByName,
    respondedBy,
    respondedAt: offer.respondedAt ? offer.respondedAt.toISOString() : null,
    createdAt: offer.createdAt.toISOString(),
  };
}

/**
 * The pane's whole payload: the offers newest first, plus how many are still
 * unanswered, so the mod-tools rail can badge the section without counting
 * client-side over a list it may not have fetched yet.
 */
export interface CommunitySupportOfferListDTO {
  offers: CommunitySupportOfferDTO[];
  openCount: number;
}
