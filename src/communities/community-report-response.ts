import { MemberRef } from '../common/member-ref';
import { ContentModerationState } from '../content-moderation/content-moderation.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { acknowledgementFor } from '../reports/report-severity';
import { EventPhoto } from '../events/entities/event-photo.entity';
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
  /**
   * What the report's subject is: a top-level post, a reply under one, or
   * (TS-13) one photograph in the album of a gathering this community hosts.
   */
  kind: 'post' | 'reply' | 'event_photo';
  /** The reported row's own id (the post id, the reply id, or the photo id). */
  id: string;
  /**
   * The thread to open. For a post this is the post's own id; for a reply it
   * is the parent post, because a reply has no page of its own and the
   * frontend links to the thread that contains it.
   *
   * ABSENT on an `event_photo`, which lives in a gathering's album and has no
   * thread at all. It is omitted rather than sent as `null` so the frontend's
   * `threadPostId?: string` stays true on the wire and the "open the thread"
   * affordance simply does not render.
   */
  postId?: string;
  /** Plain-text, whitespace-collapsed, cut at {@link REPORT_EXCERPT_LENGTH}. */
  excerpt: string;
  /** True when the body ran past the excerpt window. */
  isExcerptTruncated: boolean;
  /** When the reported content was written (ISO), distinct from the report's
   *  own `createdAt`. For a photo, when it was attached to the album. */
  authoredAt: string;
  /** The author, or `null` for an erased account (see
   *  `CommunityPost.authorId`). For a photo this is its UPLOADER, the only
   *  member `event_photos` records: nothing there says who is depicted. */
  author: MemberRef | null;
  /** The author or a moderator already tombstoned this row. Always `false` for
   *  a photo: `event_photos` has no soft-delete column, so a removed photo is
   *  gone from the table and its report arrives with `content: null`. */
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
  subjectType: 'post' | 'reply' | 'event_photo';
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

/**
 * The gathering a reported photograph belongs to, as much of it as the excerpt
 * names.
 *
 * A structural shape rather than the `Event` entity, so this response file
 * stays out of the events module's entity graph: the queue only ever needs
 * something to call the album by.
 */
export interface CommunityReportGatheringRef {
  title: string;
  slug: string;
}

/** Everything about the reported row that is not the report itself, gathered
 *  by the batched lookups in `CommunityPostsService.listCommunityReports`.
 *  Exactly one of `post`/`reply`/`photo` is ever non-null, because the service
 *  keys each report by its OWN subject type before filling this in. */
export interface CommunityReportContentInput {
  post: CommunityPost | null;
  reply: CommunityPostReply | null;
  /** TS-13: one photograph out of a community-hosted gathering's album. */
  photo: EventPhoto | null;
  /** The gathering `photo` is in, for the excerpt. Null when `photo` is. */
  gathering: CommunityReportGatheringRef | null;
  author: MemberRef | null;
  moderation: ContentModerationState;
}

/**
 * The text a photo report's excerpt is cut from.
 *
 * MIRRORS `EVENT_PHOTO_SQL` in
 * `moderation/report-subject-resolver.service.ts`, which produces this exact
 * shape for the platform queue: `(photo in the album for: <gathering>)
 * <caption clause>`, with the gathering named by its trimmed title falling
 * back to its slug, and `no caption` where a caption clause would otherwise be
 * empty. It is mirrored rather than called because that resolver is a private
 * provider of `ModerationModule` and is deliberately not exported (see the
 * "NO MODULE IMPORT IS ADDED FOR IT" note in `moderation.module.ts`). A
 * community-side reader cannot reach it without re-registering another
 * module's internals. If that shape ever changes, change it here too: a
 * moderator must not read one description of a photo in the community queue
 * and a different one in the platform queue.
 *
 * A photograph has no body, so this line IS the whole evidence a community
 * moderator gets in text. The bytes are a separate, staff-only grant (see
 * `reports/report-photo-evidence.controller.ts`).
 */
function photoExcerptSource(
  photo: EventPhoto,
  gathering: CommunityReportGatheringRef | null,
): string {
  const album = gathering
    ? `(photo in the album for: ${gathering.title.trim() || gathering.slug})`
    : '(photo, gathering not found)';
  const caption = photo.caption?.trim();
  return `${album} ${caption ? `caption: ${caption}` : 'no caption'}`;
}

function toContentDTO(
  input: CommunityReportContentInput,
): CommunityReportContentDTO | null {
  const { post, reply, photo, gathering, author, moderation } = input;
  if (photo) {
    const excerpt = toPlainTextExcerpt(
      photoExcerptSource(photo, gathering),
      REPORT_EXCERPT_LENGTH,
    );
    return {
      kind: 'event_photo',
      id: photo.id,
      // No `postId`: a photo lives in an album, which has no thread to open.
      excerpt: excerpt.text,
      isExcerptTruncated: excerpt.isTruncated,
      authoredAt: photo.createdAt.toISOString(),
      author,
      isDeleted: false,
      isHidden: moderation.hidden,
      isRemoved: moderation.removed,
    };
  }
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

/** The three taxonomy codes this queue can ever carry, narrowed from the full
 *  `ReportSubjectType` enum. `post` is the fallback because it is the only one
 *  of the three whose code is also the default shape of a community report. */
function subjectTypeOf(
  subjectType: ReportSubjectType,
): 'post' | 'reply' | 'event_photo' {
  if (subjectType === ReportSubjectType.Reply) return 'reply';
  if (subjectType === ReportSubjectType.EventPhoto) return 'event_photo';
  return 'post';
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
    // The queue's SQL already restricts subjects to this community's posts and
    // replies and to photos in its own gatherings' albums, so the narrower
    // union is the truth about what can arrive here.
    subjectType: subjectTypeOf(report.subjectType),
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
