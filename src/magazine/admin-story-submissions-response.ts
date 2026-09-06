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
  /** The staff member who last took a decline back and put this story in the
   *  queue again, and when. Both null until that happens. Reopening CLEARS the
   *  decision it undoes, so without these two the row would be back in the
   *  queue looking as if it had never been decided, and the editor who wrote
   *  the decline would have nothing telling them where it went. */
  reopenedBy: AdminPersonDTO | null;
  reopenedAt: string | null;
  /** How many times this story has been declined and put back. `reopenedAt`
   *  holds only the last one, and a story round the loop three times is a
   *  different conversation from one reopened once. */
  reopenCount: number;
  /** Set when a `commissioned` decision put this piece in the pitch inbox. */
  commissionedPitchId: string | null;
  /** Set when an `accepted` decision created the desk piece for this story.
   *  The admin surface links straight through to the desk record with it, so
   *  an acceptance is something an editor can open rather than a status word
   *  with nothing behind it. */
  acceptedPieceId: string | null;
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
  /** The staff member `submission.reopenedBy` points at, resolved by the
   *  caller in the same batched lookup as the submitter. Required rather than
   *  defaulted, so a new call site cannot quietly serve `null` on a row that
   *  really was reopened. */
  reopener: MemberRef | null,
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
    reopenedBy: toAdminPerson(reopener),
    reopenedAt: submission.reopenedAt
      ? submission.reopenedAt.toISOString()
      : null,
    reopenCount: submission.reopenCount,
    commissionedPitchId: submission.commissionedPitchId,
    acceptedPieceId: submission.acceptedPieceId,
    createdAt: submission.createdAt.toISOString(),
  };
}
