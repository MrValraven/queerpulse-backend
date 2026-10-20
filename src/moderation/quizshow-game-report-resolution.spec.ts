import { DataSource } from 'typeorm';
import { reasonsFor } from '../reports/reason-catalogue';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReportSubjectResolverService } from './report-subject-resolver.service';

const sessionId = '11111111-2222-3333-4444-555555555555';

interface Row {
  key: string;
  author_user_id: string | null;
  excerpt: string | null;
  community_id: string | null;
}

const gameReport = (subjectId = sessionId): Report => ({
  id: 'report-1',
  subjectType: ReportSubjectType.QuizshowGame,
  subjectId,
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

function build(rowsFor: { live: Row[]; snapshot: Row[] }) {
  const query = jest.fn(
    (sql: string, parameters: unknown[]): Promise<Row[]> => {
      void parameters;
      if (sql.includes('quizshow_sessions'))
        return Promise.resolve(rowsFor.live);
      if (sql.includes('quizshow-game-snapshot')) {
        return Promise.resolve(rowsFor.snapshot);
      }
      return Promise.resolve([]);
    },
  );
  const service = new ReportSubjectResolverService({
    query,
  } as unknown as DataSource);
  return { service, query };
}

describe('a Pulse Live game report', () => {
  it('resolves a game session to its owner with the game title as excerpt', async () => {
    const { service, query } = build({
      live: [
        {
          key: sessionId,
          author_user_id: 'owner-7',
          excerpt: 'Drag trivia',
          community_id: null,
        },
      ],
      snapshot: [],
    });

    const resolution = await service.resolve(gameReport());

    const liveCall = query.mock.calls.find(([sql]) =>
      sql.includes('quizshow_sessions'),
    ) as [string, unknown[]];
    expect(liveCall[0]).toContain('JOIN quizshow_quizzes');
    expect(liveCall[0]).toContain('q.owner_user_id IS NOT NULL');
    expect(liveCall[1][0]).toEqual([sessionId]);
    expect(resolution).toEqual({
      authorUserId: 'owner-7',
      excerpt: 'Drag trivia',
      communityId: null,
      isAuthorAmbiguous: false,
    });
  });

  it('falls back to the owner in the filed snapshot once the game is deleted', async () => {
    const { service, query } = build({
      live: [],
      snapshot: [
        {
          key: sessionId,
          author_user_id: 'owner-snapshot',
          excerpt: 'Filed title',
          community_id: null,
        },
      ],
    });

    const resolution = await service.resolve(gameReport());

    const snapshotCall = query.mock.calls.find(([sql]) =>
      sql.includes('quizshow-game-snapshot'),
    ) as [string, unknown[]];
    expect(snapshotCall[0]).toContain("subject_type = 'quizshow_game'");
    expect(snapshotCall[0]).toContain('DISTINCT ON');
    expect(resolution).toEqual({
      authorUserId: 'owner-snapshot',
      excerpt: 'Filed title',
      communityId: null,
      isAuthorAmbiguous: false,
    });
  });

  it('prefers the live game over the snapshot when both exist', async () => {
    const { service } = build({
      live: [
        {
          key: sessionId,
          author_user_id: 'owner-live',
          excerpt: 'Live title',
          community_id: null,
        },
      ],
      snapshot: [
        {
          key: sessionId,
          author_user_id: 'owner-snapshot',
          excerpt: 'Filed title',
          community_id: null,
        },
      ],
    });

    const resolution = await service.resolve(gameReport());

    expect(resolution.authorUserId).toBe('owner-live');
    expect(resolution.excerpt).toBe('Live title');
  });

  it('leaves an event session unresolved', async () => {
    const { service } = build({ live: [], snapshot: [] });

    expect(await service.resolve(gameReport())).toEqual({
      authorUserId: null,
      excerpt: null,
      communityId: null,
      isAuthorAmbiguous: false,
    });
  });

  it('offers the quizshow_game reasons', () => {
    expect(
      reasonsFor(ReportSubjectType.QuizshowGame).map((reason) => reason.code),
    ).toEqual([
      'hate_speech',
      'harassment',
      'discrimination',
      'outing',
      'doxxing',
      'untagged_explicit',
      'spam',
      'other',
    ]);
  });
});
