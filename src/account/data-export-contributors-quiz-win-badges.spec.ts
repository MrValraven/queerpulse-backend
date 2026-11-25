import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import {
  QuizBadgeWinsExportContributor,
  QuizGameWinsExportContributor,
} from './data-export-contributors-quiz-win-badges';
import { QuizshowGamesExportContributor } from './data-export-contributors-quizshow';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const USER_ID = '77000000-0000-4000-8000-000000000001';

describe('quiz win badges export contributors', () => {
  let query: jest.Mock;
  let winsContributor: QuizBadgeWinsExportContributor;
  let gamesContributor: QuizGameWinsExportContributor;

  beforeEach(() => {
    query = jest.fn();
    const dataSource = { query } as unknown as DataSource;
    winsContributor = new QuizBadgeWinsExportContributor(dataSource);
    gamesContributor = new QuizGameWinsExportContributor(dataSource);
  });

  it('rides on events under two keys right after quizshowGames', () => {
    expect([winsContributor.category, gamesContributor.category]).toEqual([
      'events',
      'events',
    ]);
    expect([winsContributor.archiveKey, gamesContributor.archiveKey]).toEqual([
      'quizBadgeWins',
      'quizGameWins',
    ]);
    const csvKeys: readonly string[] = EXPORT_CSV_CATEGORIES;
    const start = csvKeys.indexOf('quizshowGames');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(csvKeys.slice(start + 1, start + 3)).toEqual([
      'quizBadgeWins',
      'quizGameWins',
    ]);
    const position = NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(
      QuizBadgeWinsExportContributor,
    );
    expect(position).toBeGreaterThanOrEqual(1);
    expect(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(QuizshowGamesExportContributor),
    ).toBe(position - 1);
    expect(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(QuizGameWinsExportContributor),
    ).toBe(position + 1);
  });

  it('exports each win with the unmasked event name snapshot and visibility', async () => {
    query.mockResolvedValueOnce([
      {
        badge_key: 'quiz:def-1',
        name_en: 'Quiz Night Champion',
        name_pt: null,
        event_name_snapshot: 'Leather Night Quiz',
        game_number: 2,
        won_at: new Date('2026-11-20T22:00:00Z'),
        hidden_from_profile: true,
      },
    ]);
    expect(await winsContributor.buildContribution(USER_ID)).toEqual([
      {
        badgeKey: 'quiz:def-1',
        badgeName: { en: 'Quiz Night Champion', pt: null },
        eventName: 'Leather Night Quiz',
        gameNumber: 2,
        wonAt: '2026-11-20T22:00:00.000Z',
        hiddenFromProfile: true,
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "win"."user_id" = $1'),
      [USER_ID],
    );
  });

  it('joins the award row for visibility and orders the wins oldest first', async () => {
    query.mockResolvedValueOnce([]);
    expect(await winsContributor.buildContribution(USER_ID)).toEqual([]);
    const sql = (query.mock.calls[0] as [string, unknown[]])[0];
    expect(sql).toContain('JOIN "quiz_badge_definitions" "definition"');
    expect(sql).toContain('LEFT JOIN "recognition_awards" "award"');
    expect(sql).toContain('COALESCE("award"."hidden_from_profile", false)');
    expect(sql).toContain('ORDER BY "win"."won_at" ASC, "win"."id" ASC');
  });

  it('exports a revoked game win with its reason and a deleted event as null', async () => {
    query.mockResolvedValueOnce([
      {
        event_title: null,
        game_number: 1,
        finished_at: new Date('2026-11-18T21:00:00Z'),
        screen_name: 'Ana',
        team_name: 'Rainbow',
        revoked_at: new Date('2026-11-19T09:00:00Z'),
        revoke_reason: 'The team shared answers across tables',
      },
      {
        event_title: 'Leather Night Quiz',
        game_number: 2,
        finished_at: new Date('2026-11-20T22:00:00Z'),
        screen_name: 'Ana',
        team_name: null,
        revoked_at: null,
        revoke_reason: null,
      },
    ]);
    expect(await gamesContributor.buildContribution(USER_ID)).toEqual([
      {
        eventTitle: null,
        gameNumber: 1,
        finishedAt: '2026-11-18T21:00:00.000Z',
        screenName: 'Ana',
        teamName: 'Rainbow',
        revokedAt: '2026-11-19T09:00:00.000Z',
        revokeReason: 'The team shared answers across tables',
      },
      {
        eventTitle: 'Leather Night Quiz',
        gameNumber: 2,
        finishedAt: '2026-11-20T22:00:00.000Z',
        screenName: 'Ana',
        teamName: null,
        revokedAt: null,
        revokeReason: null,
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "winner"."user_id" = $1'),
      [USER_ID],
    );
  });

  it('never selects who revoked', async () => {
    query.mockResolvedValue([]);
    await gamesContributor.buildContribution(USER_ID);
    await winsContributor.buildContribution(USER_ID);
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls as [string, unknown[]][]) {
      expect(call[0]).not.toContain('revoked_by_id');
    }
    const gamesSql = (query.mock.calls[0] as [string, unknown[]])[0];
    expect(gamesSql).toContain('LEFT JOIN "events" "event"');
    expect(gamesSql).toContain(
      'ORDER BY "winner"."finished_at" ASC, "winner"."id" ASC',
    );
  });
});
