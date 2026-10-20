import { DataSource } from 'typeorm';
import { reasonsFor } from '../reports/reason-catalogue';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ModerationService } from './moderation.service';
import { ReportSubjectResolverService } from './report-subject-resolver.service';

const answerId = '11111111-2222-3333-4444-555555555555';

interface Row {
  key: string;
  author_user_id: string | null;
  excerpt: string | null;
  community_id: string | null;
}

const answerReport = (): Report => ({
  id: 'report-1',
  subjectType: ReportSubjectType.QuizshowAnswer,
  subjectId: answerId,
  reasonCode: 'harassment',
  detail: null,
  anonymous: false,
  contactEmail: null,
  anonymousReporterKey: null,
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
});

function build(rows: Row[]) {
  const query = jest.fn(
    (sql: string, parameters: unknown[]): Promise<Row[]> => {
      void sql;
      void parameters;
      return Promise.resolve(rows);
    },
  );
  const service = new ReportSubjectResolverService({
    query,
  } as unknown as DataSource);
  return { service, query };
}

describe('a Pulse Live answer report', () => {
  it('resolves a Pulse Live answer to its author with the screen name and text as the excerpt', async () => {
    const { service, query } = build([
      {
        key: answerId,
        author_user_id: 'author-7',
        excerpt: 'Ana: a fake answer',
        community_id: null,
      },
    ]);

    const resolution = await service.resolve(answerReport());

    const [sql, parameters] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('quizshow_answers');
    expect(sql).toContain('JOIN quizshow_players');
    expect(parameters[0]).toEqual([answerId]);
    expect(resolution).toEqual({
      authorUserId: 'author-7',
      excerpt: 'Ana: a fake answer',
      communityId: null,
      isAuthorAmbiguous: false,
    });
  });

  it('answers unresolved once the answer row is gone', async () => {
    const { service } = build([]);

    expect(await service.resolve(answerReport())).toEqual({
      authorUserId: null,
      excerpt: null,
      communityId: null,
      isAuthorAmbiguous: false,
    });
  });

  it('offers the seven reasons in order', () => {
    expect(
      reasonsFor(ReportSubjectType.QuizshowAnswer).map((reason) => reason.code),
    ).toEqual([
      'outing',
      'doxxing',
      'harassment',
      'hate_speech',
      'discrimination',
      'spam',
      'other',
    ]);
  });

  it('keeps the subject out of content takedowns', () => {
    const takedownSubjectTypes = (
      ModerationService as unknown as {
        CONTENT_TAKEDOWN_SUBJECT_TYPES: ReadonlySet<ReportSubjectType>;
      }
    ).CONTENT_TAKEDOWN_SUBJECT_TYPES;

    expect(takedownSubjectTypes.has(ReportSubjectType.QuizshowAnswer)).toBe(
      false,
    );
  });
});
