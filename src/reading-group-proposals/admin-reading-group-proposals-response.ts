import { MemberRef } from '../common/member-ref';
import {
  ReadingGroupProposal,
  ReadingGroupProposalFormat,
} from './entities/reading-group-proposal.entity';

/** Display-ready proposer on an admin oversight row. Composed from a
 * `MemberRef` so no raw profile columns leak. */
export interface AdminPersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export function toAdminPerson(ref: MemberRef | null): AdminPersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/**
 * One reading-group-proposal row on the admin oversight surface — a member
 * proposing a new group via "Start your own group". Hand-mapped from the entity;
 * the proposer is resolved to an `AdminPersonDTO` (never a raw profile row), and
 * only the fields the member themselves entered are carried through.
 */
export interface AdminReadingGroupProposalDTO {
  id: string;
  member: AdminPersonDTO | null;
  book: string;
  why: string | null;
  format: ReadingGroupProposalFormat;
  maxPeople: number;
  createdAt: string;
}

export interface AdminReadingGroupProposalsPageDTO {
  items: AdminReadingGroupProposalDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminReadingGroupProposalDTO(
  proposal: ReadingGroupProposal,
  member: MemberRef | null,
): AdminReadingGroupProposalDTO {
  return {
    id: proposal.id,
    member: toAdminPerson(member),
    book: proposal.book,
    why: proposal.why ?? null,
    format: proposal.format,
    maxPeople: proposal.maxPeople,
    createdAt: proposal.createdAt.toISOString(),
  };
}
