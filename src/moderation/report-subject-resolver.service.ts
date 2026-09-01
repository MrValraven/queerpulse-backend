import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Report, ReportSubjectType } from '../reports/entities/report.entity';

/**
 * What a report is actually about, resolved from its `(subjectType,
 * subjectId)` pair.
 *
 * Every field is independently nullable: a `venue` report has neither an
 * author nor a community, a `message` has an author but no community, and a
 * `community` report has both a community and (usually) an owner.
 */
export interface ReportSubjectResolution {
  /** The member who authored the reported content, or `null`. */
  authorUserId: string | null;
  /** A short plain-text excerpt of the reported content, or `null`. */
  excerpt: string | null;
  /** The community the reported thing belongs to, or `null`. */
  communityId: string | null;
  /**
   * True when this subject covers content written by MORE THAN ONE member and
   * the report does not record which of them was reported, so
   * {@link authorUserId} is one of the candidates rather than the answer.
   *
   * Two subject types can be true today, for the same structural reason.
   *
   *  - `listing_public_question`: one row holds a member's question AND the
   *    listing owner's answer posted under it, and the single "Report this"
   *    control on the card sits below both halves
   *    (`DirectoryQuestionCard.tsx`). A member reporting the ANSWER files a
   *    report indistinguishable from one about the question.
   *  - `review`: one row holds a member's review AND the reviewed party's
   *    single public reply under it (a listing owner, an employer, or a
   *    lister), and again one report control sits below both halves
   *    (`CompanyTabs.tsx`, `HousingReviewCard.tsx`). The taxonomy says so
   *    itself: `ReportSubjectType.Review`'s own doc records that a review's
   *    reply is deliberately not separately takedown-able, because a reply
   *    read without the review it answers is not the same statement. That
   *    reasoning makes the pair one subject, and it makes the author of the
   *    reported half unknowable in exactly the same way.
   *
   * Read by the enforcement path, which must refuse rather than sanction a
   * coin-flip: a wrong ban costs someone their place in a community they are
   * probably relying on, and the platform never learns it was wrong. The read
   * path is free to keep showing `authorUserId` (the asker opened the
   * exchange), because naming who is on screen is not the same act as
   * choosing who to punish.
   */
  isAuthorAmbiguous: boolean;
}

/**
 * The shape every lookup query in this file selects.
 *
 * `is_author_ambiguous` is the one OPTIONAL alias: only a statement whose
 * subject can genuinely cover two authors selects it, and node-postgres yields
 * `undefined` for a column a statement never named, which {@link
 * ReportSubjectResolverService.runLookup} reads as `false`. Adding a constant
 * `FALSE AS is_author_ambiguous` to the statements whose subject has exactly
 * one author would say nothing they do not already say by omission.
 */
interface RawSubjectRow {
  key: string;
  author_user_id: string | null;
  excerpt: string | null;
  community_id: string | null;
  is_author_ambiguous?: boolean | null;
}

const UNRESOLVED: ReportSubjectResolution = {
  authorUserId: null,
  excerpt: null,
  communityId: null,
  isAuthorAmbiguous: false,
};

// Loose enough to guard a `uuid`-typed column from a Postgres "invalid input
// syntax for type uuid" error when a non-uuid `subjectId` (a slug, the
// `"unspecified"` sentinel the safety form files, ...) reaches a lookup keyed
// by id. Same pattern (and same reason) as `AccountEnforcementService`'s copy.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How long an excerpt may run before it is cut. Long enough to read a whole
 *  short post, short enough to sit on one moderation queue row. */
const EXCERPT_MAX_LENGTH = 280;

/**
 * Collapses a reported body into one line of at most {@link
 * EXCERPT_MAX_LENGTH} characters. Returns `null` for an empty or
 * whitespace-only body so callers can tell "nothing to show" apart from "an
 * empty string is what they wrote".
 */
function toExcerpt(raw: string | null): string | null {
  if (!raw) return null;
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  return collapsed.length > EXCERPT_MAX_LENGTH
    ? `${collapsed.slice(0, EXCERPT_MAX_LENGTH).trimEnd()}...`
    : collapsed;
}

/**
 * Resolves a report's subject to the member behind it, a readable excerpt of
 * what was reported, and the community it belongs to.
 *
 * WHY THIS EXISTS: three separate surfaces used to guess. `warn` notified
 * nobody on a content report, `suspend`/`ban`/`restrict` threw a 400 on one,
 * and the queue could only name a community when the community itself was the
 * subject. All three needed the same answer, so they now ask the same object
 * for it.
 *
 * WHY RAW SQL: the twenty subject types this covers span twelve feature
 * modules. Importing those modules (or even their entities) would drag their
 * whole dependency graphs into `ModerationModule` and create real import
 * cycles: `CommunitiesModule` already imports `ContentModerationModule` which
 * `ModerationModule` also imports, and `ForumModule` imports `ModerationModule`
 * itself for `ModAuditService`. A scoped, read-only, parameterized query
 * through the shared `DataSource` reads exactly the columns needed and adds no
 * edge to the module graph at all. Every table and column named here is
 * verified against the entity that owns it; the entity remains the owner, this
 * is a reader.
 *
 * WHY BATCHED: `ModerationService.toRows` builds a whole queue page, and a
 * per-report resolution would be a query per row. {@link resolveMany} groups a
 * page by subject type and issues one query per TABLE a present subject type
 * spans (one for most, two for `post`/`reply`/`member`/`subprofile`, three for
 * `review`) rather than one per report, mirroring the batching
 * `toAppealRows`/`profilesByUserIds` already use.
 */
@Injectable()
export class ReportSubjectResolverService {
  constructor(private readonly dataSource: DataSource) {}

  /** One report's subject. Never throws: an unresolvable subject reads as
   *  three nulls rather than an error, because every caller is enriching a
   *  decision rather than gating one. */
  async resolve(report: Report): Promise<ReportSubjectResolution> {
    const resolutions = await this.resolveMany([report]);
    return resolutions.get(report.id) ?? UNRESOLVED;
  }

  /**
   * A whole page of reports, keyed by `report.id`.
   *
   * Reports whose subject cannot be resolved are simply absent from the map,
   * so callers should treat absence as {@link UNRESOLVED}.
   */
  async resolveMany(
    reports: Report[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    const byReportId = new Map<string, ReportSubjectResolution>();
    if (!reports.length) return byReportId;

    const subjectIdsByType = new Map<ReportSubjectType, Set<string>>();
    for (const report of reports) {
      const existing = subjectIdsByType.get(report.subjectType);
      if (existing) {
        existing.add(report.subjectId);
      } else {
        subjectIdsByType.set(report.subjectType, new Set([report.subjectId]));
      }
    }

    const resolvedByType = new Map<
      ReportSubjectType,
      Map<string, ReportSubjectResolution>
    >();
    await Promise.all(
      [...subjectIdsByType.entries()].map(async ([subjectType, subjectIds]) => {
        resolvedByType.set(
          subjectType,
          await this.resolveSubjectIds(subjectType, [...subjectIds]),
        );
      }),
    );

    for (const report of reports) {
      const resolved = resolvedByType
        .get(report.subjectType)
        ?.get(report.subjectId);
      if (resolved) byReportId.set(report.id, resolved);
    }
    return byReportId;
  }

  /**
   * Every subject id of ONE type, resolved in a bounded number of queries.
   *
   * `post` and `reply` each span two tables: a community post/reply
   * (`community_posts` / `community_post_replies`) and a forum post
   * (`forum_post`, which backs both a thread's opening post and its replies).
   * The frontend files both under the same two subject types, so both tables
   * are read and merged. Ids are uuids from disjoint tables, so a merge can
   * never pick the wrong row.
   *
   * `review` spans THREE tables for the same reason: `listing_reviews`,
   * `company_reviews` and `housing_reviews` all file under the single `review`
   * code (`DirectoryService.REVIEW_SUBJECT_TYPE`,
   * `CompaniesService.REVIEW_SUBJECT_TYPE`,
   * `HousingReviewsService.REVIEW_SUBJECT_TYPE` are the same string), and the
   * report carries only a uuid, so nothing on the wire says which table to look
   * in. Every one of the three ids is `uuid_generate_v4()` with no fixed id
   * anywhere in the seed or the migrations, so the merge cannot pick the wrong
   * row. Reusing one code was the right call and a fourth taxonomy value would
   * have been the wrong one; the missing arms were simply never added here,
   * which left a company or housing review report showing a moderator no
   * excerpt and no author at all.
   */
  private async resolveSubjectIds(
    subjectType: ReportSubjectType,
    subjectIds: string[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    switch (subjectType) {
      case ReportSubjectType.Member:
        return this.resolveMembers(subjectIds);

      case ReportSubjectType.Post:
        return this.mergeSources(
          await Promise.all([
            this.queryByUuid(COMMUNITY_POST_SQL, subjectIds),
            this.queryByUuid(FORUM_POST_SQL, subjectIds),
          ]),
        );

      case ReportSubjectType.Reply:
        return this.mergeSources(
          await Promise.all([
            this.queryByUuid(COMMUNITY_REPLY_SQL, subjectIds),
            this.queryByUuid(FORUM_POST_SQL, subjectIds),
          ]),
        );

      case ReportSubjectType.Message:
        return this.queryByUuid(MESSAGE_SQL, subjectIds);

      case ReportSubjectType.Review:
        return this.mergeSources(
          await Promise.all([
            this.queryByUuid(LISTING_REVIEW_SQL, subjectIds),
            this.queryByUuid(COMPANY_REVIEW_SQL, subjectIds),
            this.queryByUuid(HOUSING_REVIEW_SQL, subjectIds),
          ]),
        );

      case ReportSubjectType.MagazineComment:
        return this.queryByUuid(MAGAZINE_COMMENT_SQL, subjectIds);

      case ReportSubjectType.ListingPublicQuestion:
        return this.queryByUuid(LISTING_PUBLIC_QUESTION_SQL, subjectIds);

      case ReportSubjectType.Subprofile:
        // Addressed by uuid from the persona page, but a slug is a legitimate
        // way to name a persona elsewhere, so both are read.
        return this.mergeSources(
          await Promise.all([
            this.queryByUuid(SUBPROFILE_BY_ID_SQL, subjectIds),
            this.queryBySlug(SUBPROFILE_BY_SLUG_SQL, subjectIds),
          ]),
        );

      case ReportSubjectType.Event:
        return this.queryBySlug(EVENT_SQL, subjectIds);

      // ONE photograph out of a gathering's album, keyed by the photo's own
      // uuid. `event` beside it is a whole grain coarser and names the
      // gathering by slug, so the two never collide.
      case ReportSubjectType.EventPhoto:
        return this.queryByUuid(EVENT_PHOTO_SQL, subjectIds);

      // `business` is the directory's public face of the very same
      // `listings` row a `listing` report names, addressed by the same slug.
      case ReportSubjectType.Listing:
      case ReportSubjectType.Business:
        return this.queryBySlug(LISTING_SQL, subjectIds);

      case ReportSubjectType.Housing:
        return this.queryBySlug(HOUSING_LISTING_SQL, subjectIds);

      case ReportSubjectType.Flatmate:
        return this.queryBySlug(FLATMATE_PROFILE_SQL, subjectIds);

      case ReportSubjectType.Community:
        return this.queryBySlug(COMMUNITY_SQL, subjectIds);

      case ReportSubjectType.Job:
        return this.queryBySlug(JOB_SQL, subjectIds);

      case ReportSubjectType.Company:
        return this.queryBySlug(COMPANY_SQL, subjectIds);

      case ReportSubjectType.Landlord:
        return this.queryBySlug(LANDLORD_SQL, subjectIds);

      // ONE tenant's recommendation of a landlord, keyed by the
      // recommendation's own uuid. `landlord` beside it names the whole
      // directory entry by slug, and acting on that would take down every
      // other tenant's warning about the same landlord.
      case ReportSubjectType.LandlordRecommendation:
        return this.queryByUuid(LANDLORD_RECOMMENDATION_SQL, subjectIds);

      // A `venue` report is filed from the safety form, which deliberately
      // sends the `"unspecified"` sentinel rather than an id (see
      // `ReportSections.tsx`): the reporter describes the place in prose. The
      // local directory's venues are demo-only and have no table of their own,
      // so there is genuinely nobody to resolve. Three nulls, never a guess.
      case ReportSubjectType.Venue:
        return new Map();
    }
  }

  /**
   * `member` subjects, which are addressed by profile slug or by user id
   * depending on where the report was filed (see `Report`'s entity doc).
   *
   * The slug lookup wins a collision, mirroring the `[{ slug }, { userId }]`
   * where-array `AccountEnforcementService.resolveReportedProfile` has always
   * used, so the read path and the enforcement path resolve the same person.
   */
  private async resolveMembers(
    subjectIds: string[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    const [byUserId, bySlug] = await Promise.all([
      this.queryByUuid(PROFILE_BY_USER_ID_SQL, subjectIds),
      this.queryBySlug(PROFILE_BY_SLUG_SQL, subjectIds),
    ]);
    return this.mergeSources([byUserId, bySlug]);
  }

  /**
   * Folds several per-table lookups into one map. LATER sources win, so
   * callers list the weaker source first (a merge only ever fires when two
   * disjoint tables were both asked about the same id, which for uuid keys
   * cannot happen at all).
   */
  private mergeSources(
    sources: Map<string, ReportSubjectResolution>[],
  ): Map<string, ReportSubjectResolution> {
    const merged = new Map<string, ReportSubjectResolution>();
    for (const source of sources) {
      for (const [key, resolution] of source) merged.set(key, resolution);
    }
    return merged;
  }

  /** Runs a lookup keyed by a `uuid` column, dropping non-uuid subject ids
   *  before they can reach Postgres and blow up the whole query. */
  private queryByUuid(
    sql: string,
    subjectIds: string[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    return this.runLookup(
      sql,
      subjectIds.filter((subjectId) => UUID_RE.test(subjectId)),
    );
  }

  /** Runs a lookup keyed by a `varchar` slug column, which accepts any string. */
  private queryBySlug(
    sql: string,
    subjectIds: string[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    return this.runLookup(sql, subjectIds);
  }

  private async runLookup(
    sql: string,
    keys: string[],
  ): Promise<Map<string, ReportSubjectResolution>> {
    const byKey = new Map<string, ReportSubjectResolution>();
    if (!keys.length) return byKey;

    const rows = await this.dataSource.query<RawSubjectRow[]>(sql, [keys]);
    for (const row of rows) {
      byKey.set(row.key, {
        authorUserId: row.author_user_id ?? null,
        excerpt: toExcerpt(row.excerpt),
        communityId: row.community_id ?? null,
        // Absent on every statement whose subject has exactly one author.
        // See `RawSubjectRow`.
        isAuthorAmbiguous: row.is_author_ambiguous === true,
      });
    }
    return byKey;
  }
}

/*
 * Every statement below selects the same four aliases (`key`,
 * `author_user_id`, `excerpt`, `community_id`) so {@link
 * ReportSubjectResolverService.runLookup} can stay one generic reader, plus an
 * optional fifth (`is_author_ambiguous`) that only the one statement whose
 * subject can cover two authors bothers to name. `$1` is always the array of
 * subject ids; `= ANY(...)` keeps it a single indexed lookup regardless of page
 * size.
 *
 * The `author_user_id` column is nullable on most of these tables because
 * erasing an account sets it NULL rather than deleting the content (see
 * `SetNullContentAuthorFksOnUserErasure`). An erased author resolves to `null`,
 * which is the honest answer: there is no account left to notify or sanction.
 */

const PROFILE_BY_USER_ID_SQL = `
  SELECT p.user_id::text AS key,
         p.user_id       AS author_user_id,
         NULL::text      AS excerpt,
         NULL::uuid      AS community_id
  FROM profiles p
  WHERE p.user_id = ANY($1::uuid[])
`;

const PROFILE_BY_SLUG_SQL = `
  SELECT p.slug     AS key,
         p.user_id  AS author_user_id,
         NULL::text AS excerpt,
         NULL::uuid AS community_id
  FROM profiles p
  WHERE p.slug = ANY($1::text[])
`;

const COMMUNITY_POST_SQL = `
  SELECT cp.id::text     AS key,
         cp.author_id    AS author_user_id,
         cp.body         AS excerpt,
         cp.community_id AS community_id
  FROM community_posts cp
  WHERE cp.id = ANY($1::uuid[])
`;

const COMMUNITY_REPLY_SQL = `
  SELECT cpr.id::text    AS key,
         cpr.author_id   AS author_user_id,
         cpr.body        AS excerpt,
         cp.community_id AS community_id
  FROM community_post_replies cpr
  LEFT JOIN community_posts cp ON cp.id = cpr.post_id
  WHERE cpr.id = ANY($1::uuid[])
`;

// One table backs both a forum thread's opening post and every reply under it,
// so the same statement answers a `post` and a `reply` subject. Forum threads
// live outside communities, hence the constant NULL community.
const FORUM_POST_SQL = `
  SELECT fp.id::text  AS key,
         fp.author_id AS author_user_id,
         fp.body      AS excerpt,
         NULL::uuid   AS community_id
  FROM forum_post fp
  WHERE fp.id = ANY($1::uuid[])
`;

const MESSAGE_SQL = `
  SELECT m.id::text  AS key,
         m.sender_id AS author_user_id,
         m.body      AS excerpt,
         NULL::uuid  AS community_id
  FROM messages m
  WHERE m.id = ANY($1::uuid[])
`;

/*
 * THE THREE `review` STATEMENTS.
 *
 * A `review` report is keyed by a bare uuid and can name a row in any of
 * `listing_reviews`, `company_reviews` or `housing_reviews`. All three are read
 * and merged (see `resolveSubjectIds`).
 *
 * ONE SUBJECT COVERS THE REVIEW AND THE REPLY UNDER IT, on all three. That is
 * the taxonomy's own stated rule (`ReportSubjectType.Review`) and both newer
 * verticals were built to it: the reviewed party's single public answer lives
 * on the review row (`owner_reply_text` / `lister_reply_text`), it is not
 * separately takedown-able, and the one "Report this" control on the card sits
 * below both halves. Two things follow, and both are safety-relevant.
 *
 *  1. The excerpt SHOWS THE REPLY when there is one. A moderator reading only
 *     the review is judging half an exchange, and the half they cannot see is
 *     the half a reporter may well have meant.
 *  2. `is_author_ambiguous` is TRUE when a reply exists, exactly as it is for
 *     `listing_public_question`. `author_user_id` stays the reviewer, because
 *     the drawer has to name somebody and they opened the exchange; the flag is
 *     what stops `restrict`/`suspend`/`ban` landing on them for words the
 *     employer, the listing owner or the lister wrote. Without it, a report
 *     filed against an abusive employer reply resolves to the REVIEWER and bans
 *     the person the reply was aimed at.
 *
 * A blank or absent reply is not two authors, so the flag is false there and
 * the ordinary case (a review nobody has answered) stays fully actionable.
 */

const LISTING_REVIEW_SQL = `
  SELECT lr.id::text    AS key,
         lr.reviewer_id AS author_user_id,
         CASE
           WHEN NULLIF(btrim(lr.owner_reply_text), '') IS NULL THEN lr.text
           ELSE concat_ws(' ', NULLIF(btrim(lr.text), ''), '/ reply:',
                          lr.owner_reply_text)
         END            AS excerpt,
         NULL::uuid     AS community_id,
         (NULLIF(btrim(lr.owner_reply_text), '') IS NOT NULL)
                        AS is_author_ambiguous
  FROM listing_reviews lr
  WHERE lr.id = ANY($1::uuid[])
`;

// `company_reviews.body` is a jsonb ARRAY of paragraphs, so the readable text
// has to be joined back together; `title` leads it, because that is the line
// the page shows first and often the whole complaint. `jsonb_typeof` guards the
// join: a row whose `body` was somehow not an array would otherwise raise and
// take out the WHOLE moderation queue page this statement is batching for.
//
// `author_id` is nullable (`ON DELETE SET NULL` on account erasure), so an
// erased reviewer resolves to `null` and the enforcement path answers
// `no_account` rather than sanctioning anyone.
const COMPANY_REVIEW_SQL = `
  SELECT cr.id::text  AS key,
         cr.author_id AS author_user_id,
         CASE
           WHEN NULLIF(btrim(cr.owner_reply_text), '') IS NULL
             THEN NULLIF(written.body, '')
           ELSE concat_ws(' ', NULLIF(written.body, ''), '/ reply:',
                          cr.owner_reply_text)
         END        AS excerpt,
         NULL::uuid AS community_id,
         (NULLIF(btrim(cr.owner_reply_text), '') IS NOT NULL)
                    AS is_author_ambiguous
  FROM company_reviews cr
  LEFT JOIN LATERAL (
    SELECT btrim(concat_ws(
             ' ',
             NULLIF(btrim(cr.title), ''),
             CASE
               WHEN jsonb_typeof(cr.body) = 'array' THEN (
                 SELECT string_agg(paragraph, ' ')
                 FROM jsonb_array_elements_text(cr.body) AS paragraph
               )
             END
           )) AS body
  ) written ON TRUE
  WHERE cr.id = ANY($1::uuid[])
`;

/**
 * The anti-retaliation window from `HousingReviewsService.REVEAL_WINDOW_MS`,
 * spelled as a Postgres interval.
 *
 * DUPLICATED ON PURPOSE, like every table and column name in this file: the
 * constant is `private static` on a service in `HousingReviewsModule`, and
 * importing that module to read one number is exactly the dependency edge the
 * "WHY RAW SQL" note above exists to avoid. If the product changes the window,
 * change it in both places; the two are named after each other so a grep for
 * either finds the other.
 */
const HOUSING_REVIEW_REVEAL_WINDOW = '14 days';

/**
 * A housing review, which is BLIND until it reveals.
 *
 * `author_id` IS NULLABLE and `subject_id` IS THE OTHER PARTY. Reading
 * `subject_id` when `author_id` is null would resolve an enforcement action
 * onto the person the review is ABOUT, which is the worst outcome this file
 * can produce, so an erased author resolves to `null` and the enforcement path
 * answers `no_account`. Nothing here ever falls back to `subject_id`.
 *
 * WHAT AN UNREVEALED REVIEW SHOWS, and why: the text, marked as not yet
 * revealed. Reveal is a rule BETWEEN THE TWO PARTIES (neither reads the other
 * until both have written, or the window elapses) and it exists so neither can
 * write in retaliation for what the other said. A moderator is neither party.
 * Withholding the text would hand them a report they cannot judge while its SLA
 * runs, and the drawer is staff-gated, so showing it leaks nothing to either
 * side. The marker is still worth carrying because it changes the reading: a
 * review nobody has seen yet has done no harm yet, and that belongs in the
 * severity call.
 *
 * The reveal predicate is the same one the reads use
 * (`HousingReviewsService.isRevealed`): the pair is complete, counted over
 * every review sharing the viewing, or the window has elapsed since submission.
 */
const HOUSING_REVIEW_SQL = `
  SELECT hr.id::text  AS key,
         hr.author_id AS author_user_id,
         concat_ws(
           ' ',
           CASE WHEN revealed.is_revealed THEN NULL ELSE '(not revealed yet)' END,
           CASE
             WHEN NULLIF(btrim(hr.lister_reply_text), '') IS NULL
               THEN NULLIF(btrim(hr.text), '')
             ELSE concat_ws(' ', NULLIF(btrim(hr.text), ''), '/ reply:',
                            hr.lister_reply_text)
           END
         )          AS excerpt,
         NULL::uuid AS community_id,
         (NULLIF(btrim(hr.lister_reply_text), '') IS NOT NULL)
                    AS is_author_ambiguous
  FROM housing_reviews hr
  LEFT JOIN LATERAL (
    SELECT (
      (
        SELECT count(*) FROM housing_reviews pair
        WHERE pair.viewing_id = hr.viewing_id
      ) >= 2
      OR hr.submitted_at <= now() - interval '${HOUSING_REVIEW_REVEAL_WINDOW}'
    ) AS is_revealed
  ) revealed ON TRUE
  WHERE hr.id = ANY($1::uuid[])
`;

const MAGAZINE_COMMENT_SQL = `
  SELECT mrc.id::text  AS key,
         mrc.author_id AS author_user_id,
         mrc.body      AS excerpt,
         NULL::uuid    AS community_id
  FROM magazine_reader_comment mrc
  WHERE mrc.id = ANY($1::uuid[])
`;

// One subject covers the question AND the answer posted under it (see
// `ReportSubjectType.ListingPublicQuestion`), so the excerpt shows the question
// with the answer appended when there is one.
//
// THE AUTHOR IS THEREFORE NOT ALWAYS KNOWABLE, and this is the only statement
// in this file where that is true. The asker wrote the question; somebody else
// (the listing's owner, a later owner after a claim, or a moderator; see
// `ListingPublicQuestion.isAnsweredByModerator`) wrote the answer. The single
// "Report this" control on the card sits below both halves and sends only the
// question's uuid, so nothing on the wire says which half a member meant.
//
// `author_user_id` stays the asker, which is right for the READ path: they
// opened the exchange and the drawer has to name somebody. `is_author_ambiguous`
// is how the ENFORCEMENT path learns not to trust it. Answered by the asker
// themselves is not ambiguous at all (both halves are then the same member),
// and neither is an answer that is absent or blank.
const LISTING_PUBLIC_QUESTION_SQL = `
  SELECT lpq.id::text AS key,
         lpq.asker_id AS author_user_id,
         CASE
           WHEN lpq.answer IS NULL OR lpq.answer = '' THEN lpq.body
           ELSE lpq.body || ' / ' || lpq.answer
         END        AS excerpt,
         NULL::uuid AS community_id,
         (
           lpq.answer IS NOT NULL
           AND btrim(lpq.answer) <> ''
           AND lpq.answered_by_id IS DISTINCT FROM lpq.asker_id
         )          AS is_author_ambiguous
  FROM listing_public_questions lpq
  WHERE lpq.id = ANY($1::uuid[])
`;

const SUBPROFILE_BY_ID_SQL = `
  SELECT s.id::text AS key,
         s.user_id  AS author_user_id,
         COALESCE(NULLIF(s.tagline, ''), NULLIF(s.bio, ''), s.display_name)
                    AS excerpt,
         NULL::uuid AS community_id
  FROM subprofiles s
  WHERE s.id = ANY($1::uuid[])
`;

const SUBPROFILE_BY_SLUG_SQL = `
  SELECT s.slug     AS key,
         s.user_id  AS author_user_id,
         COALESCE(NULLIF(s.tagline, ''), NULLIF(s.bio, ''), s.display_name)
                    AS excerpt,
         NULL::uuid AS community_id
  FROM subprofiles s
  WHERE s.slug = ANY($1::text[])
`;

// A gathering hosted inside a community carries that community, so a report
// about it lands on the right room's tally.
const EVENT_SQL = `
  SELECT e.slug         AS key,
         e.host_id      AS author_user_id,
         COALESCE(NULLIF(e.title, ''), NULLIF(e.description, ''))
                        AS excerpt,
         e.community_id AS community_id
  FROM events e
  WHERE e.slug = ANY($1::text[])
`;

/**
 * ONE photograph in a gathering's album.
 *
 * WHAT A MODERATOR GETS FOR A SUBJECT MADE ENTIRELY OF IMAGE. There is no body
 * to quote, and an empty excerpt would fall through to the reporter's own words
 * (`ModerationService.buildDetail` reads `subject.excerpt ?? report.detail`),
 * which reads on the queue exactly like a photo whose caption says what the
 * reporter says. So the excerpt is deliberate instead: a marker naming the
 * subject as a photograph, THE GATHERING WHOSE ALBUM IT IS IN, and then the
 * caption, or the fact that there is none. The marker convention is the one
 * `HOUSING_REVIEW_SQL` already uses for `(not revealed yet)`.
 *
 * THE GATHERING COMES BEFORE THE CAPTION on purpose. `toExcerpt` cuts at 280
 * characters, and a long caption must never be what pushes the gathering's name
 * off the row: a moderator judging "is this photo outing someone" is judging it
 * against the event it was taken at, and a picture in a trans support group's
 * album is not the same report as the same picture in a public street party's.
 *
 * `uploader_id` IS NULLABLE (`ON DELETE SET NULL`, see
 * `AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`), so an uploader
 * who erased their account resolves to `null` and the enforcement path answers
 * `no_account`. It never falls back to the gathering's `host_id`: the host is a
 * different person from the uploader on most albums, and resolving an
 * enforcement action onto them would sanction somebody who did nothing but run
 * the event.
 *
 * The gathering's community rides along, exactly as `EVENT_SQL` does it, so a
 * photo reported out of a community's gathering lands on that community's
 * tally. `LEFT JOIN` because a photo whose gathering is somehow gone still has
 * an uploader worth naming.
 *
 * NOT AUTHOR-AMBIGUOUS, and the statement therefore does not name that column.
 * A photo row carries exactly one member's contribution: the uploader supplied
 * the image, and the caption is theirs too. Attach is organizer-only
 * (`EventPhotosService.attach`) AND the global `StorageKeyOwnershipInterceptor`
 * only lets a member send a storage key they uploaded, with
 * `EventPhotosController` deliberately absent from `shared-upload-handlers.ts`.
 * The one caption-editing path is a repeat POST of the same key, so only the
 * uploader can ever have written the caption. There is no reply, no second
 * field, and nobody else's words on the row.
 */
const EVENT_PHOTO_SQL = `
  SELECT ep.id::text    AS key,
         ep.uploader_id AS author_user_id,
         concat_ws(
           ' ',
           CASE
             WHEN e.id IS NULL THEN '(photo, gathering not found)'
             ELSE concat('(photo in the album for: ',
                         COALESCE(NULLIF(btrim(e.title), ''), e.slug), ')')
           END,
           CASE
             WHEN NULLIF(btrim(ep.caption), '') IS NULL THEN 'no caption'
             ELSE concat('caption: ', btrim(ep.caption))
           END
         )              AS excerpt,
         e.community_id AS community_id
  FROM event_photos ep
  LEFT JOIN events e ON e.id = ep.event_id
  WHERE ep.id = ANY($1::uuid[])
`;

// `owner_id` is NULL for an unclaimed directory entry, which is exactly right:
// nobody wrote it, so nobody can be warned for it.
const LISTING_SQL = `
  SELECT l.slug     AS key,
         l.owner_id AS author_user_id,
         COALESCE(NULLIF(l.blurb, ''), NULLIF(l.tagline, ''), NULLIF(l.name, ''))
                    AS excerpt,
         NULL::uuid AS community_id
  FROM listings l
  WHERE l.slug = ANY($1::text[])
`;

const HOUSING_LISTING_SQL = `
  SELECT h.slug     AS key,
         h.owner_id AS author_user_id,
         COALESCE(NULLIF(h.title, ''), NULLIF(h.description, ''))
                    AS excerpt,
         NULL::uuid AS community_id
  FROM housing_listings h
  WHERE h.slug = ANY($1::text[])
`;

const FLATMATE_PROFILE_SQL = `
  SELECT f.slug         AS key,
         f.owner_id     AS author_user_id,
         NULLIF(f.about, '') AS excerpt,
         NULL::uuid     AS community_id
  FROM flatmate_profiles f
  WHERE f.slug = ANY($1::text[])
`;

// The community's own row: its owner answers for it, and it IS its own
// community for attribution.
const COMMUNITY_SQL = `
  SELECT c.slug     AS key,
         c.owner_id AS author_user_id,
         COALESCE(NULLIF(c.tagline, ''), NULLIF(c.purpose, ''), NULLIF(c.name, ''))
                    AS excerpt,
         c.id       AS community_id
  FROM communities c
  WHERE c.slug = ANY($1::text[])
`;

// `desc` is a reserved word, hence the quoting.
const JOB_SQL = `
  SELECT j.slug      AS key,
         j.poster_id AS author_user_id,
         COALESCE(NULLIF(j.title, ''), NULLIF(j."desc", ''))
                     AS excerpt,
         NULL::uuid  AS community_id
  FROM jobs j
  WHERE j.slug = ANY($1::text[])
`;

const COMPANY_SQL = `
  SELECT co.slug     AS key,
         co.owner_id AS author_user_id,
         COALESCE(NULLIF(co.tagline, ''), NULLIF(co.about, ''), NULLIF(co.name_text, ''))
                     AS excerpt,
         NULL::uuid  AS community_id
  FROM companies co
  WHERE co.slug = ANY($1::text[])
`;

// A landlord entry is a community-submitted directory record; the submitter is
// who wrote it (NULL for an admin-created or an erased submitter).
const LANDLORD_SQL = `
  SELECT la.slug                 AS key,
         la.submitted_by_user_id AS author_user_id,
         COALESCE(NULLIF(la.tagline, ''), NULLIF(la.note, ''), NULLIF(la.name, ''))
                                 AS excerpt,
         NULL::uuid              AS community_id
  FROM landlords la
  WHERE la.slug = ANY($1::text[])
`;

/**
 * ONE tenant's recommendation of a landlord: stars plus text, one row per
 * member per landlord.
 *
 * The recommendation's own text IS the excerpt. It is the whole of what was
 * reported, and it is what tenants write to warn each other, so a moderator
 * reads the words themselves rather than a summary of the directory entry they
 * hang under. `NULLIF(btrim(...))` so a whitespace-only row reads as nothing to
 * show rather than a blank quote.
 *
 * `author_user_id` IS NULLABLE. The FK moved from `ON DELETE CASCADE` to `ON
 * DELETE SET NULL` (`SetNullLandlordRecommendationAuthorFk1797900000000`) so
 * that erasing an account stops silently deleting the warnings other tenants
 * are relying on, which leaves author-less rows behind exactly as an erased
 * housing reviewer does: they resolve to `null`, the enforcement path answers
 * `no_account`, and nothing here ever falls back to `landlord_id`, which names
 * the landlord the recommendation is ABOUT. That fallback is the same mistake
 * `HOUSING_REVIEW_SQL` refuses for `subject_id`, and it would aim a sanction at
 * the reported party.
 *
 * A landlord entry belongs to no community, hence the constant NULL.
 *
 * NOT AUTHOR-AMBIGUOUS, and the statement therefore does not name that column.
 * The row is `(landlord_id, author_user_id, stars, text, created_at)`: there is
 * no reply field and no second contributor, so unlike a review the reported
 * words can only be the one author's.
 */
const LANDLORD_RECOMMENDATION_SQL = `
  SELECT lrec.id::text             AS key,
         lrec.author_user_id       AS author_user_id,
         NULLIF(btrim(lrec.text), '') AS excerpt,
         NULL::uuid                AS community_id
  FROM landlord_recommendations lrec
  WHERE lrec.id = ANY($1::uuid[])
`;
