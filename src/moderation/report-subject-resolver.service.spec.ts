import { DataSource } from 'typeorm';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReportSubjectResolverService } from './report-subject-resolver.service';

const baseReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-1',
  subjectType: ReportSubjectType.Post,
  subjectId: '11111111-2222-3333-4444-555555555555',
  reasonCode: 'harassment',
  detail: null,
  anonymous: false,
  contactEmail: null,
  evidence: null,
  severity: ReportSeverity.High,
  slaDueAt: new Date('2026-01-02T00:00:00.000Z'),
  status: ReportStatus.Open,
  reporterId: 'reporter-1',
  assignedModeratorId: null,
  assignedAt: null,
  resolvedAt: null,
  resolutionActorId: null,
  resolutionAction: null,
  resolutionDuration: null,
  resolutionNote: null,
  resolutionNotified: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

/** The raw row shape every statement in the resolver selects.
 *  `is_author_ambiguous` is optional exactly as it is in the resolver: only the
 *  one statement whose subject can cover two authors names that column. */
interface Row {
  key: string;
  author_user_id: string | null;
  excerpt: string | null;
  community_id: string | null;
  is_author_ambiguous?: boolean;
}

function build(rowsFor: (sql: string, keys: string[]) => Row[] = () => []) {
  const query = jest.fn((sql: string, parameters: unknown[]): Promise<Row[]> =>
    Promise.resolve(rowsFor(sql, (parameters[0] ?? []) as string[])),
  );
  const service = new ReportSubjectResolverService({
    query,
  } as unknown as DataSource);
  return { service, query };
}

/** Every subject-id array a lookup was actually asked about. */
const askedKeys = (query: jest.Mock): string[][] =>
  (query.mock.calls as [string, unknown[]][]).map(
    ([, parameters]) => (parameters[0] ?? []) as string[],
  );

describe('ReportSubjectResolverService', () => {
  describe('a subject with an author', () => {
    it('resolves the author, the excerpt and the owning community', async () => {
      const { service } = build((sql, keys) =>
        sql.includes('community_posts cp')
          ? [
              {
                key: keys[0]!,
                author_user_id: 'author-9',
                excerpt: '  the   reported\n  body ',
                community_id: 'community-1',
              },
            ]
          : [],
      );

      const resolution = await service.resolve(baseReport());

      expect(resolution).toEqual({
        authorUserId: 'author-9',
        // Whitespace is collapsed so the excerpt sits on one queue row.
        excerpt: 'the reported body',
        communityId: 'community-1',
        // A community post has exactly one author, so its statement never
        // names the column and the reader reads the absence as `false`.
        isAuthorAmbiguous: false,
      });
    });

    it('cuts a long body rather than putting a whole post on a row', async () => {
      const { service } = build((sql, keys) =>
        sql.includes('community_posts cp')
          ? [
              {
                key: keys[0]!,
                author_user_id: 'author-9',
                excerpt: 'x'.repeat(600),
                community_id: null,
              },
            ]
          : [],
      );

      const { excerpt } = await service.resolve(baseReport());

      expect(excerpt).toHaveLength(283);
      expect(excerpt?.endsWith('...')).toBe(true);
    });

    it('reads an empty body as nothing to show', async () => {
      const { service } = build((sql, keys) =>
        sql.includes('community_posts cp')
          ? [
              {
                key: keys[0]!,
                author_user_id: 'author-9',
                excerpt: '   ',
                community_id: null,
              },
            ]
          : [],
      );

      expect((await service.resolve(baseReport())).excerpt).toBeNull();
    });
  });

  /**
   * The `listing_public_question` subject is the ONE subject that can cover
   * content by two different members: the asker's question and the listing
   * owner's answer under it. The card carries a single "Report this" control
   * below both halves, so a report about the ANSWER arrives indistinguishable
   * from one about the question, and `author_user_id` is always the asker.
   * Enforcement therefore has to be told not to trust it.
   */
  describe('a public question with an answer under it', () => {
    const questionReport = () =>
      baseReport({
        subjectType: ReportSubjectType.ListingPublicQuestion,
        subjectId: '33333333-3333-3333-3333-333333333333',
      });

    const answered = (isAuthorAmbiguous: boolean) =>
      build((sql, keys) =>
        sql.includes('listing_public_questions lpq')
          ? [
              {
                key: keys[0]!,
                author_user_id: 'asker-1',
                excerpt: 'is the entrance step-free? / read the sign',
                community_id: null,
                is_author_ambiguous: isAuthorAmbiguous,
              },
            ]
          : [],
      );

    it('flags the author as ambiguous, while still naming the asker', async () => {
      const { service } = answered(true);

      const resolution = await service.resolve(questionReport());

      // The asker is still returned: the drawer has to name somebody, and they
      // opened the exchange. `isAuthorAmbiguous` is what stops a sanction
      // being aimed at them on the strength of it.
      expect(resolution.authorUserId).toBe('asker-1');
      expect(resolution.isAuthorAmbiguous).toBe(true);
    });

    it('is not ambiguous when the row says only one member wrote it', async () => {
      const { service } = answered(false);

      expect((await service.resolve(questionReport())).isAuthorAmbiguous).toBe(
        false,
      );
    });

    it('asks Postgres for the ambiguity rather than deciding it here', async () => {
      const { service, query } = answered(true);

      await service.resolve(questionReport());

      const [sql] = (query.mock.calls as [string, unknown[]][])[0]!;
      expect(sql).toContain('is_author_ambiguous');
      // Blank and absent answers are not two authors, and neither is an owner
      // answering their own question.
      expect(sql).toContain("btrim(lpq.answer) <> ''");
      expect(sql).toContain('lpq.answered_by_id IS DISTINCT FROM lpq.asker_id');
    });
  });

  /**
   * A `review` report is a bare uuid that can name a row in any of THREE
   * tables: `listing_reviews` (a directory listing), `company_reviews` (an
   * employer) and `housing_reviews` (a home). All three file under the same
   * `review` code on purpose, so all three are read and merged here.
   *
   * Before these arms existed only `listing_reviews` was read, so a report
   * against a company or housing review reached the queue with no excerpt and
   * no author, and an account action on it answered
   * `ENFORCEMENT_TARGET_UNRESOLVED`.
   */
  describe('a review, whichever of the three tables it lives in', () => {
    const reviewId = '44444444-4444-4444-4444-444444444444';
    const reviewReport = () =>
      baseReport({
        subjectType: ReportSubjectType.Review,
        subjectId: reviewId,
      });

    /** Answers rows from exactly one of the three review statements. */
    const onlyFrom = (table: string, row: Omit<Row, 'key'>) =>
      build((sql, keys) =>
        sql.includes(table) ? [{ key: keys[0]!, ...row }] : [],
      );

    it('reads all three review tables for one report', async () => {
      const { service, query } = build();

      await service.resolve(reviewReport());

      const statements = (query.mock.calls as [string, unknown[]][]).map(
        ([sql]) => sql,
      );
      expect(statements).toHaveLength(3);
      expect(statements.some((sql) => sql.includes('listing_reviews lr'))).toBe(
        true,
      );
      expect(statements.some((sql) => sql.includes('company_reviews cr'))).toBe(
        true,
      );
      expect(statements.some((sql) => sql.includes('housing_reviews hr'))).toBe(
        true,
      );
      // One statement per table for the whole page, never one per report.
      for (const keys of askedKeys(query)) {
        expect(keys).toEqual([reviewId]);
      }
    });

    it('resolves a directory listing review to its reviewer', async () => {
      const { service } = onlyFrom('listing_reviews lr', {
        author_user_id: 'reviewer-1',
        excerpt: 'the step at the door is not marked',
        community_id: null,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBe('reviewer-1');
      expect(resolution.excerpt).toBe('the step at the door is not marked');
    });

    it('resolves an employer review to its author', async () => {
      const { service } = onlyFrom('company_reviews cr', {
        author_user_id: 'reviewer-2',
        excerpt: 'Hard place to be out  they made a joke of my pronouns',
        community_id: null,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBe('reviewer-2');
      expect(resolution.excerpt).toBe(
        'Hard place to be out they made a joke of my pronouns',
      );
    });

    it('resolves a housing review to its author', async () => {
      const { service } = onlyFrom('housing_reviews hr', {
        author_user_id: 'reviewer-3',
        excerpt: 'the room was not the room in the photos',
        community_id: null,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBe('reviewer-3');
      expect(resolution.excerpt).toBe(
        'the room was not the room in the photos',
      );
    });

    /**
     * `housing_reviews.author_id` is nullable (`ON DELETE SET NULL` on account
     * erasure) and `subject_id` beside it is THE OTHER PARTY. Falling back to
     * it would aim an enforcement action at the person the review is about, so
     * the honest answer is nobody: the enforcement path then refuses with
     * `no_account` rather than sanctioning anyone.
     */
    it('degrades to no target when the housing review author erased their account', async () => {
      const { service } = onlyFrom('housing_reviews hr', {
        author_user_id: null,
        excerpt: 'the room was not the room in the photos',
        community_id: null,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBeNull();
      // Nobody to act on is not the same as two candidates.
      expect(resolution.isAuthorAmbiguous).toBe(false);
      // The moderator still reads what was reported.
      expect(resolution.excerpt).toBe(
        'the room was not the room in the photos',
      );
    });

    /**
     * One subject covers the review AND the single public reply under it, on
     * all three surfaces, so the author of the reported half is unknowable in
     * exactly the way an answered public question's is. The reviewer is still
     * named (the drawer has to name somebody), and the flag is what keeps a
     * sanction off them for the employer's or the lister's words.
     */
    it('flags the author as ambiguous when a reply sits under the review', async () => {
      const { service } = onlyFrom('company_reviews cr', {
        author_user_id: 'reviewer-2',
        excerpt: 'they made a joke of my pronouns / reply: get over yourself',
        community_id: null,
        is_author_ambiguous: true,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBe('reviewer-2');
      expect(resolution.isAuthorAmbiguous).toBe(true);
    });

    it('leaves an unanswered review fully actionable', async () => {
      const { service } = onlyFrom('company_reviews cr', {
        author_user_id: 'reviewer-2',
        excerpt: 'they made a joke of my pronouns',
        community_id: null,
        is_author_ambiguous: false,
      });

      const resolution = await service.resolve(reviewReport());

      expect(resolution.authorUserId).toBe('reviewer-2');
      expect(resolution.isAuthorAmbiguous).toBe(false);
    });

    it('asks Postgres for the reply and the ambiguity rather than deciding them here', async () => {
      const { service, query } = build();

      await service.resolve(reviewReport());

      const statements = (query.mock.calls as [string, unknown[]][]).map(
        ([sql]) => sql,
      );
      for (const sql of statements) {
        expect(sql).toContain('is_author_ambiguous');
        // The reply is shown to the moderator, so they are never judging half
        // of an exchange.
        expect(sql).toContain('/ reply:');
      }
      // A blank reply is not a second author, so every arm trims before it
      // decides.
      for (const sql of statements) {
        expect(sql).toContain('NULLIF(btrim(');
      }
    });

    /**
     * A housing review is BLIND until it reveals. The moderator reads it
     * anyway (they are neither party, the drawer is staff-gated, and a report
     * they cannot read is a report they cannot judge), marked so the severity
     * call knows nobody has seen it yet.
     */
    it('marks an unrevealed housing review rather than hiding it', async () => {
      const { service, query } = build();

      await service.resolve(reviewReport());

      const housingSql = (query.mock.calls as [string, unknown[]][])
        .map(([sql]) => sql)
        .find((sql) => sql.includes('housing_reviews hr'))!;
      expect(housingSql).toContain('(not revealed yet)');
      // The same reveal predicate the public reads use: the pair is complete,
      // or the anti-retaliation window elapsed.
      expect(housingSql).toContain('pair.viewing_id = hr.viewing_id');
      expect(housingSql).toContain("interval '14 days'");
      // Never `subject_id`, which is the OTHER party.
      expect(housingSql).toContain('hr.author_id AS author_user_id');
      expect(housingSql).not.toContain('subject_id AS author_user_id');
    });
  });

  /**
   * ONE photograph out of a gathering's album. The subject exists because
   * `event` is a grain too coarse: acting on it takes down the whole gathering
   * over a single image.
   */
  describe('a photo in a gathering album', () => {
    const photoId = '55555555-5555-5555-5555-555555555555';
    const photoReport = () =>
      baseReport({
        subjectType: ReportSubjectType.EventPhoto,
        subjectId: photoId,
      });

    /** Answers one row from the event-photo statement, and nothing else. */
    const photoRow = (row: Omit<Row, 'key'>) =>
      build((sql, keys) =>
        sql.includes('event_photos ep') ? [{ key: keys[0]!, ...row }] : [],
      );

    it('resolves the photo to the member who uploaded it', async () => {
      const { service, query } = photoRow({
        author_user_id: 'uploader-1',
        excerpt:
          '(photo in the album for: Trans picnic) caption: us at the park',
        community_id: 'community-7',
      });

      const resolution = await service.resolve(photoReport());

      expect(resolution.authorUserId).toBe('uploader-1');
      // The gathering's community rides along, so a photo reported out of a
      // community's gathering lands on that community's tally.
      expect(resolution.communityId).toBe('community-7');
      expect(resolution.isAuthorAmbiguous).toBe(false);
      // One uuid-keyed statement for the subject, never one per report.
      expect(query).toHaveBeenCalledTimes(1);
      expect(askedKeys(query)).toEqual([[photoId]]);
    });

    it('says which gathering the photo hangs in, and that a photo is what it is', async () => {
      const { service } = photoRow({
        author_user_id: 'uploader-1',
        excerpt: '(photo in the album for: Trans picnic) no caption',
        community_id: null,
      });

      // A subject made entirely of image still reads as something on the
      // queue: what it is, and the gathering it was taken at.
      expect((await service.resolve(photoReport())).excerpt).toBe(
        '(photo in the album for: Trans picnic) no caption',
      );
    });

    /**
     * `event_photos.uploader_id` is `ON DELETE SET NULL`
     * (`AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`), so a
     * member who erased their account leaves the photo behind with no
     * uploader. Nobody is the honest answer, and the enforcement path then
     * refuses with `no_account`.
     */
    it('degrades to no target when the uploader erased their account', async () => {
      const { service } = photoRow({
        author_user_id: null,
        excerpt: '(photo in the album for: Trans picnic) no caption',
        community_id: 'community-7',
      });

      const resolution = await service.resolve(photoReport());

      expect(resolution.authorUserId).toBeNull();
      // Nobody to act on is not the same as two candidates.
      expect(resolution.isAuthorAmbiguous).toBe(false);
      // The moderator still reads what was reported and where it sits.
      expect(resolution.excerpt).toBe(
        '(photo in the album for: Trans picnic) no caption',
      );
    });

    it('builds the excerpt in Postgres and never falls back to the host', async () => {
      const { service, query } = build();

      await service.resolve(photoReport());

      const [sql] = (query.mock.calls as [string, unknown[]][])[0]!;
      // The enforcement target is the uploader. The gathering's host is a
      // different person on most albums, and sanctioning them would punish
      // somebody who did nothing but run the event.
      expect(sql).toContain('ep.uploader_id AS author_user_id');
      expect(sql).not.toContain('host_id');
      // A photo has no body, so the excerpt is written rather than left empty:
      // the gathering comes first so a long caption can never push it off the
      // row, and a captionless photo says so.
      expect(sql).toContain('(photo in the album for: ');
      expect(sql).toContain("'no caption'");
      expect(sql).toContain('e.community_id AS community_id');
      // A photo whose gathering is somehow gone still has an uploader worth
      // naming.
      expect(sql).toContain('LEFT JOIN events e ON e.id = ep.event_id');
      // One member's contribution only: the uploader supplied the image and
      // wrote the caption, so the statement never names the ambiguity column.
      expect(sql).not.toContain('is_author_ambiguous');
    });
  });

  /**
   * ONE tenant's recommendation of a landlord. `landlord` beside it names the
   * whole directory entry, and acting on that takes down every other tenant's
   * warning about the same landlord.
   */
  describe('a landlord recommendation', () => {
    const recommendationId = '66666666-6666-6666-6666-666666666666';
    const recommendationReport = () =>
      baseReport({
        subjectType: ReportSubjectType.LandlordRecommendation,
        subjectId: recommendationId,
      });

    /** Answers one row from the recommendation statement, and nothing else. */
    const recommendationRow = (row: Omit<Row, 'key'>) =>
      build((sql, keys) =>
        sql.includes('landlord_recommendations lrec')
          ? [{ key: keys[0]!, ...row }]
          : [],
      );

    it('resolves the recommendation to its author and shows what they wrote', async () => {
      const { service, query } = recommendationRow({
        author_user_id: 'tenant-1',
        excerpt: 'he asked me who my partner was before he would show the flat',
        community_id: null,
      });

      const resolution = await service.resolve(recommendationReport());

      expect(resolution.authorUserId).toBe('tenant-1');
      expect(resolution.excerpt).toBe(
        'he asked me who my partner was before he would show the flat',
      );
      // A landlord entry belongs to no community.
      expect(resolution.communityId).toBeNull();
      expect(resolution.isAuthorAmbiguous).toBe(false);
      expect(query).toHaveBeenCalledTimes(1);
      expect(askedKeys(query)).toEqual([[recommendationId]]);
    });

    /**
     * `author_user_id` is nullable: the FK is `ON DELETE SET NULL` so that
     * erasing an account stops deleting the warnings other tenants rely on. An
     * author-less row resolves to nobody, exactly as an erased housing-review
     * author does.
     */
    it('degrades to no target when the recommendation has no author left', async () => {
      const { service } = recommendationRow({
        author_user_id: null,
        excerpt: 'he asked me who my partner was before he would show the flat',
        community_id: null,
      });

      const resolution = await service.resolve(recommendationReport());

      expect(resolution.authorUserId).toBeNull();
      expect(resolution.isAuthorAmbiguous).toBe(false);
      expect(resolution.excerpt).toBe(
        'he asked me who my partner was before he would show the flat',
      );
    });

    it('never falls back to the landlord the recommendation is about', async () => {
      const { service, query } = build();

      await service.resolve(recommendationReport());

      const [sql] = (query.mock.calls as [string, unknown[]][])[0]!;
      expect(sql).toMatch(/lrec\.author_user_id\s+AS author_user_id/);
      // `landlord_id` is the reported party. Reading it would aim an
      // enforcement action at them, the same mistake the housing-review
      // statement refuses for `subject_id`.
      expect(sql).not.toMatch(/landlord_id\s+AS author_user_id/);
      // A whitespace-only recommendation reads as nothing to show.
      expect(sql).toContain("NULLIF(btrim(lrec.text), '')");
      // The row has no reply field and no second contributor, so the
      // statement never names the ambiguity column.
      expect(sql).not.toContain('is_author_ambiguous');
    });
  });

  describe('a subject with nothing to resolve', () => {
    it('answers three nulls rather than guessing', async () => {
      const { service } = build();

      expect(await service.resolve(baseReport())).toEqual({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        // Nothing resolved is not the same as two candidates.
        isAuthorAmbiguous: false,
      });
    });

    it('never queries at all for a venue, which has no table', async () => {
      const { service, query } = build();

      const resolution = await service.resolve(
        baseReport({
          subjectType: ReportSubjectType.Venue,
          subjectId: 'unspecified',
        }),
      );

      expect(resolution.authorUserId).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });
  });

  /**
   * `subjectId` is a `varchar` carrying anything a reporting surface put there.
   * A slug reaching a `uuid`-typed lookup is a Postgres "invalid input syntax
   * for type uuid" error that fails the WHOLE page, so non-uuid ids are dropped
   * before the query rather than after.
   */
  it('keeps a non-uuid subject id away from a uuid-keyed lookup', async () => {
    const { service, query } = build();

    await service.resolve(
      baseReport({
        subjectType: ReportSubjectType.Message,
        subjectId: 'unspecified',
      }),
    );

    expect(query).not.toHaveBeenCalled();
  });

  describe('resolveMany', () => {
    it('asks once per table for a whole page, not once per report', async () => {
      const firstPostId = '11111111-1111-1111-1111-111111111111';
      const secondPostId = '22222222-2222-2222-2222-222222222222';
      const { service, query } = build((sql, keys) =>
        sql.includes('community_posts cp')
          ? keys.map((key) => ({
              key,
              author_user_id: `author-${key.slice(0, 1)}`,
              excerpt: 'body',
              community_id: 'community-1',
            }))
          : [],
      );

      const resolutions = await service.resolveMany([
        baseReport({ id: 'report-1', subjectId: firstPostId }),
        baseReport({ id: 'report-2', subjectId: secondPostId }),
      ]);

      expect(resolutions.get('report-1')?.authorUserId).toBe('author-1');
      expect(resolutions.get('report-2')?.authorUserId).toBe('author-2');
      // `post` spans two tables (a community post and a forum post), so two
      // statements for the page. Never four.
      expect(query).toHaveBeenCalledTimes(2);
      for (const keys of askedKeys(query)) {
        expect(keys).toEqual([firstPostId, secondPostId]);
      }
    });

    it('de-duplicates two reports about the same subject', async () => {
      const postId = '11111111-1111-1111-1111-111111111111';
      const { service, query } = build((sql, keys) =>
        sql.includes('community_posts cp')
          ? keys.map((key) => ({
              key,
              author_user_id: 'author-9',
              excerpt: 'body',
              community_id: null,
            }))
          : [],
      );

      const resolutions = await service.resolveMany([
        baseReport({ id: 'report-1', subjectId: postId }),
        baseReport({ id: 'report-2', subjectId: postId }),
      ]);

      expect(resolutions.get('report-1')?.authorUserId).toBe('author-9');
      expect(resolutions.get('report-2')?.authorUserId).toBe('author-9');
      for (const keys of askedKeys(query)) {
        expect(keys).toEqual([postId]);
      }
    });

    it('leaves an unresolvable report out of the map entirely', async () => {
      const { service } = build();

      const resolutions = await service.resolveMany([baseReport()]);

      expect(resolutions.has('report-1')).toBe(false);
    });

    it('resolves a member subject by slug', async () => {
      const { service } = build((sql, keys) =>
        sql.includes('p.slug = ANY')
          ? [
              {
                key: keys[0]!,
                author_user_id: 'user-1',
                excerpt: null,
                community_id: null,
              },
            ]
          : [],
      );

      const resolution = await service.resolve(
        baseReport({
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      );

      expect(resolution.authorUserId).toBe('user-1');
      expect(resolution.communityId).toBeNull();
    });
  });
});
