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
   * Exactly one subject type can be true today: `listing_public_question`,
   * where one row holds a member's question AND the listing owner's answer
   * posted under it, and the single "Report this" control on the card sits
   * below both halves (`DirectoryQuestionCard.tsx`). A member reporting the
   * ANSWER files a report indistinguishable from one about the question.
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
 * `FALSE AS is_author_ambiguous` to the other nineteen statements would say
 * nothing they do not already say by omission.
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
 * WHY RAW SQL: the seventeen subject types this covers span twelve feature
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
 * page by subject type and issues at most two queries per distinct type
 * present, mirroring the batching `toAppealRows`/`profilesByUserIds` already
 * use.
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
        return this.queryByUuid(LISTING_REVIEW_SQL, subjectIds);

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

const LISTING_REVIEW_SQL = `
  SELECT lr.id::text    AS key,
         lr.reviewer_id AS author_user_id,
         lr.text        AS excerpt,
         NULL::uuid     AS community_id
  FROM listing_reviews lr
  WHERE lr.id = ANY($1::uuid[])
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
