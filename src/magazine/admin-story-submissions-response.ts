import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import {
  MagazineStorySubmission,
  SubmissionDecision,
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
 *
 * `deck`/`body`/`coverUrl` are what a decider needs to actually READ the piece
 * before deciding (CON-01 — they used to be concatenated into `pitch` or, for
 * the cover, discarded). `coverUrl` is served through `toImageUrl`, never the
 * raw storage key.
 */
export interface AdminStorySubmissionDTO {
  id: string;
  submitter: AdminPersonDTO | null;
  format: string;
  workingTitle: string;
  pitch: string;
  deck: string | null;
  body: string | null;
  coverUrl: string | null;
  status: SubmissionStatus;
  decision: SubmissionDecision | null;
  decisionNote: string | null;
  decidedAt: string | null;
  /** Set when a `commissioned` decision put this piece in the pitch inbox. */
  commissionedPitchId: string | null;
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
    deck: submission.deck,
    body: submission.body,
    coverUrl: toImageUrl(submission.coverImageKey),
    status: submission.status,
    decision: submission.decision,
    decisionNote: submission.decisionNote,
    decidedAt: submission.decidedAt ? submission.decidedAt.toISOString() : null,
    commissionedPitchId: submission.commissionedPitchId,
    createdAt: submission.createdAt.toISOString(),
  };
}
