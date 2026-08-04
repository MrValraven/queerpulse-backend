import { MemberRef } from '../common/member-ref';
import {
  MagazineStorySubmission,
  SubmissionStatus,
} from './entities/magazine-story-submission.entity';

/** Display-ready submitter on an admin oversight row. Composed from a
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
 * One magazine story-submission row on the admin oversight surface — a reader's
 * pitch to the magazine. Hand-mapped from the entity; the submitter is resolved
 * to an `AdminPersonDTO` (never a raw profile row), and the pitch fields are
 * carried through as the member wrote them.
 */
export interface AdminStorySubmissionDTO {
  id: string;
  submitter: AdminPersonDTO | null;
  format: string;
  workingTitle: string;
  pitch: string;
  status: SubmissionStatus;
  createdAt: string;
}

export interface AdminStorySubmissionsPageDTO {
  items: AdminStorySubmissionDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminStorySubmissionDTO(
  submission: MagazineStorySubmission,
  submitter: MemberRef | null,
): AdminStorySubmissionDTO {
  return {
    id: submission.id,
    submitter: toAdminPerson(submitter),
    format: submission.format,
    workingTitle: submission.workingTitle,
    pitch: submission.pitch,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
  };
}
