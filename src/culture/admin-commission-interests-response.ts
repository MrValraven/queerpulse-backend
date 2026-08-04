import { MemberRef } from '../common/member-ref';
import {
  CommissionCategory,
  CommissionInterest,
} from './entities/commission-interest.entity';

/** Display-ready submitter on an admin oversight row: the member's slug, a
 * pre-composed name, and a resolved avatar URL. Composed from a `MemberRef`
 * so no raw profile columns leak. */
export interface AdminPersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

/** Map a batched `MemberRef` to the admin person shape (name pre-composed for
 * the frontend), or `null` when the profile could not be resolved. */
export function toAdminPerson(ref: MemberRef | null): AdminPersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/**
 * One commission-interest row on the admin oversight surface — a member
 * reaching out about a Commission Board project. Hand-mapped from the entity;
 * the submitter is resolved to an `AdminPersonDTO` (never a raw profile row),
 * and only the denormalized commission fields the member themselves saw are
 * carried through.
 */
export interface AdminCommissionInterestDTO {
  id: string;
  member: AdminPersonDTO | null;
  commissionTitle: string;
  commissionCategory: CommissionCategory;
  recipientName: string;
  message: string | null;
  createdAt: string;
}

export interface AdminCommissionInterestsPageDTO {
  items: AdminCommissionInterestDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminCommissionInterestDTO(
  interest: CommissionInterest,
  member: MemberRef | null,
): AdminCommissionInterestDTO {
  return {
    id: interest.id,
    member: toAdminPerson(member),
    commissionTitle: interest.commissionTitle,
    commissionCategory: interest.commissionCategory,
    recipientName: interest.recipientName,
    message: interest.message ?? null,
    createdAt: interest.createdAt.toISOString(),
  };
}
