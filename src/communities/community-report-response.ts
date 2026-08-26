import { MemberRef } from '../common/member-ref';
import { ContentModerationState } from '../content-moderation/content-moderation.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { acknowledgementFor } from '../reports/report-severity';
import { toPlainTextExcerpt } from './community-plain-text';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';

/**
 * How much of a reported post or reply the community moderation queue carries.
 * Long enough that a moderator can read the statement they are being asked to
 * judge, short enough that a page of 200 reports stays a small response. The
 * frontend renders the excerpt with a "there is more" affordance when
 * `isExcerptTruncated` is set and links through to the thread for the rest.
 */
export const REPORT_EXCERPT_LENGTH = 320;

/**
 * The reported content itself, resolved and attached to its report.
 *
 * A community owner/co-owner/mod already reads moderation-hidden content in
 * their own community (`CommunityPostsService.isStaffRole` gates every feed
 * read that way), so the body travels with the report for exactly the same
 * audience. `null` on the report means the row it pointed at is gone from the
 * table entirely, which is the one case a moderator cannot be shown anything.
 */
export interface CommunityReportContentDTO {
  /** Whether the report's subject is a top-level post or a reply under one. */
  kind: 'post' | 'reply';
  /** The reported row's own id (the post id, or the reply id). */
  id: string;
  /**
   * The thread to open. For a post this is the post's own id; for a reply it
   * is the parent post, because a reply has no page of its own and the
   * frontend links to the thread that contains it.
   */
  postId: string;
  /** Plain-text, whitespace-collapsed, cut at {@link REPORT_EXCERPT_LENGTH}. */
  excerpt: string;
  /** True when the body ran past the excerpt window. */
  isExcerptTruncated: boolean;
  /** When the reported content was written (ISO), distinct from the report's
   *  own `createdAt`. */
  authoredAt: string;
  /** The author, or `null` for an erased account (see
   *  `CommunityPost.authorId`). */
  author: MemberRef | null;
  /** The author or a moderator already tombstoned this row. */
  isDeleted: boolean;
  /** Moderation-hidden: withheld from ordinary members right now. */
  isHidden: boolean;
  /** Moderation-removed: a tombstone everyone sees. */
  isRemoved: boolean;
}

/**
 * One open report in a community's own moderation queue, with the content it
 * is about.
 *
 * Mirrors `CommunityReportDTO` in
 * `queerpulse/src/features/communities/api/communities.api.ts` exactly. It is
 * a superset of the platform-wide `ReportDTO` (`reports/report-response.ts`):
 * the same report fields, plus the derived `isOverdue` and the resolved
 * `content` block a moderator needs in order to decide anything.
 */
export interface CommunityReportDTO {
  id: string;
  subjectType: 'post' | 'reply';
  subjectId: string;
  reasonCode: string;
  severity: ReportSeverity;
  status: ReportStatus;
  createdAt: string;
  slaDueAt: string;
  /** The SLA window has already closed on an open report. Derived at read
   *  time from `slaDueAt`, so no column drifts out of date. */
  isOverdue: boolean;
  acknowledgement: string;
  content: CommunityReportContentDTO | null;
}

/** Everything about the reported row that is not the report itself, gathered
 *  by the batched lookups in `CommunityPostsService.listCommunityReports`. */
export interface CommunityReportContentInput {
  post: CommunityPost | null;
  reply: CommunityPostReply | null;
  author: MemberRef | null;
  moderation: ContentModerationState;
}

function toContentDTO(
  input: CommunityReportContentInput,
): CommunityReportContentDTO | null {
  const { post, reply, author, moderation } = input;
  if (reply) {
    const excerpt = toPlainTextExcerpt(reply.text, REPORT_EXCERPT_LENGTH);
    return {
      kind: 'reply',
      id: reply.id,
      postId: reply.postId,
      excerpt: excerpt.text,
      isExcerptTruncated: excerpt.isTruncated,
      authoredAt: reply.createdAt.toISOString(),
      author,
      isDeleted: reply.deletedAt !== null,
      isHidden: moderation.hidden,
      isRemoved: moderation.removed,
    };
  }
  if (!post) return null;
  const excerpt = toPlainTextExcerpt(post.body, REPORT_EXCERPT_LENGTH);
  return {
    kind: 'post',
    id: post.id,
    postId: post.id,
    excerpt: excerpt.text,
    isExcerptTruncated: excerpt.isTruncated,
    authoredAt: post.createdAt.toISOString(),
    author,
    isDeleted: post.deletedAt !== null,
    isHidden: moderation.hidden,
    isRemoved: moderation.removed,
  };
}

/**
 * Maps one report plus its already-resolved content to the queue DTO.
 *
 * `now` is passed in rather than read here so a whole page shares one clock
 * reading: two rows with the same `slaDueAt` can never disagree about being
 * overdue, and a test can pin the boundary.
 */
export function toCommunityReportDTO(
  report: Report,
  content: CommunityReportContentInput,
  now: Date,
): CommunityReportDTO {
  return {
    id: report.id,
    // The queue's SQL already restricts subjects to community posts and
    // replies, so the narrower union is the truth about what can arrive here.
    subjectType:
      report.subjectType === ReportSubjectType.Reply ? 'reply' : 'post',
    subjectId: report.subjectId,
    reasonCode: report.reasonCode,
    severity: report.severity,
    status: report.status,
    createdAt: report.createdAt.toISOString(),
    slaDueAt: report.slaDueAt.toISOString(),
    isOverdue:
      report.status === ReportStatus.Open &&
      report.slaDueAt.getTime() < now.getTime(),
    acknowledgement: acknowledgementFor(report.severity),
    content: toContentDTO(content),
  };
}
