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
