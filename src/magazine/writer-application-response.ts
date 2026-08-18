import { MemberRef } from '../common/member-ref';
import {
  MagazineWriterApplication,
  WriterApplicationStatus,
} from './entities/magazine-writer-application.entity';

/**
 * One writer application, as returned to the applicant themselves
 * (`GET /magazine/writer-applications/mine`) — no admin-only fields beyond
 * `reviewNote`, which the applicant is meant to see.
 */
export interface WriterApplicationDTO {
  id: string;
  pitchNote: string | null;
  sampleText: string | null;
  sampleLink: string | null;
  status: WriterApplicationStatus;
  reviewNote: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export function toWriterApplicationDTO(
  application: MagazineWriterApplication,
): WriterApplicationDTO {
  return {
    id: application.id,
    pitchNote: application.pitchNote,
    sampleText: application.sampleText,
    sampleLink: application.sampleLink,
    status: application.status,
    reviewNote: application.reviewNote,
    createdAt: application.createdAt.toISOString(),
    reviewedAt: application.reviewedAt
      ? application.reviewedAt.toISOString()
      : null,
  };
}

/** Display-ready applicant on an admin queue row. Composed from a
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

export interface AdminWriterApplicationDTO extends WriterApplicationDTO {
  applicant: AdminPersonDTO | null;
}

export function toAdminWriterApplicationDTO(
  application: MagazineWriterApplication,
  applicant: MemberRef | null,
): AdminWriterApplicationDTO {
  return {
    ...toWriterApplicationDTO(application),
    applicant: toAdminPerson(applicant),
  };
}

export interface AdminWriterApplicationsPageDTO {
  items: AdminWriterApplicationDTO[];
  total: number;
  page: number;
  pageSize: number;
}
