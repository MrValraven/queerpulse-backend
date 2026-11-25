import type { EntityManager } from 'typeorm';
import {
  readResultsWinBadges,
  RESULTS_SESSION_GAME_SQL,
  RESULTS_WIN_ROWS_SQL,
} from './quiz-win-badges-results-reads';

function collapsed(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

function sessionRow(
  gameNumber: number | null,
  eventId: string | null = 'event-1',
) {
  return { event_id: eventId, event_game_number: gameNumber };
}

function winRow(input: {
  winnerId: string;
  screenName: string;
  teamName: string | null;
  definitionId: string;
  isMine: boolean;
}) {
  return {
    is_mine: input.isMine,
    winner_id: input.winnerId,
    screen_name: input.screenName,
    team_name: input.teamName,
    definition_id: input.definitionId,
    badge_key: `quiz:${input.definitionId}`,
    name_en: `Badge ${input.definitionId}`,
    name_pt: null,
    icon_key: 'star',
    tint: 'jade',
    rarity: 'rare',
    archived_at: null,
  };
}

function fakeManager(session: unknown, winRows: unknown[] = []) {
  const query = jest.fn((sql: string) => {
    if (sql === RESULTS_SESSION_GAME_SQL) {
      return Promise.resolve(session === null ? [] : [session]);
    }
    if (sql === RESULTS_WIN_ROWS_SQL) {
      return Promise.resolve(winRows);
    }
    return Promise.reject(new Error('unexpected query'));
  });
  return {
    manager: { query } as unknown as Pick<EntityManager, 'query'>,
    query,
  };
}

const teamsInput = {
  sessionId: 'session-1',
  viewerUserId: 'user-1',
  playMode: 'teams' as const,
};

describe('readResultsWinBadges', () => {
  it('returns null for a game session and for an unnumbered session', async () => {
    const gameSession = fakeManager(sessionRow(2, null));
    const unnumbered = fakeManager(sessionRow(null));
    const missing = fakeManager(null);

    await expect(
      readResultsWinBadges(gameSession.manager, teamsInput),
    ).resolves.toBeNull();
    await expect(
      readResultsWinBadges(unnumbered.manager, teamsInput),
    ).resolves.toBeNull();
    await expect(
      readResultsWinBadges(missing.manager, teamsInput),
    ).resolves.toBeNull();
    expect(gameSession.query).toHaveBeenCalledTimes(1);
  });

  it('returns null when no live win row came back', async () => {
    const { manager } = fakeManager(sessionRow(1), []);

    await expect(readResultsWinBadges(manager, teamsInput)).resolves.toBeNull();
  });

  it('groups a winning team under its name with the viewer chips', async () => {
    const { manager, query } = fakeManager(sessionRow(3), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: true,
      }),
      winRow({
        winnerId: 'winner-2',
        screenName: 'Bo',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: false,
      }),
    ]);

    const card = await readResultsWinBadges(manager, teamsInput);

    expect(card).toEqual({
      gameNumber: 3,
      winners: [
        {
          kind: 'team',
          name: 'Glitter Brains',
          badges: [expect.objectContaining({ definitionId: 'def-1' })],
        },
      ],
      myBadges: [expect.objectContaining({ definitionId: 'def-1' })],
    });
    expect(query).toHaveBeenCalledWith(RESULTS_WIN_ROWS_SQL, [
      'session-1',
      'user-1',
    ]);
  });

  it('lists a teams winner with no team name by screen name', async () => {
    const { manager } = fakeManager(sessionRow(1), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: null,
        definitionId: 'def-1',
        isMine: false,
      }),
      winRow({
        winnerId: 'winner-2',
        screenName: 'Bo',
        teamName: null,
        definitionId: 'def-1',
        isMine: false,
      }),
    ]);

    const card = await readResultsWinBadges(manager, teamsInput);

    expect(card?.winners.map((winner) => [winner.kind, winner.name])).toEqual([
      ['player', 'Ana'],
      ['player', 'Bo'],
    ]);
  });

  it('lists solo winners by screen name in name order', async () => {
    const { manager } = fakeManager(sessionRow(1), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Zed',
        teamName: null,
        definitionId: 'def-1',
        isMine: false,
      }),
      winRow({
        winnerId: 'winner-2',
        screenName: 'Ana',
        teamName: null,
        definitionId: 'def-1',
        isMine: true,
      }),
    ]);

    const card = await readResultsWinBadges(manager, {
      ...teamsInput,
      playMode: 'solo',
    });

    expect(card?.winners.map((winner) => [winner.kind, winner.name])).toEqual([
      ['player', 'Ana'],
      ['player', 'Zed'],
    ]);
  });

  it('keeps solo winners who share a team name apart', async () => {
    const { manager } = fakeManager(sessionRow(1), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: false,
      }),
      winRow({
        winnerId: 'winner-2',
        screenName: 'Bo',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: false,
      }),
    ]);

    const card = await readResultsWinBadges(manager, {
      ...teamsInput,
      playMode: 'solo',
    });

    expect(card?.winners.map((winner) => winner.name)).toEqual(['Ana', 'Bo']);
  });

  it('deduplicates chips per entry and keeps several badges of one winner', async () => {
    const { manager } = fakeManager(sessionRow(1), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: true,
      }),
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: 'Glitter Brains',
        definitionId: 'def-2',
        isMine: true,
      }),
      winRow({
        winnerId: 'winner-2',
        screenName: 'Bo',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: false,
      }),
    ]);

    const card = await readResultsWinBadges(manager, teamsInput);

    expect(card?.winners).toHaveLength(1);
    expect(card?.winners[0]?.badges.map((chip) => chip.definitionId)).toEqual([
      'def-1',
      'def-2',
    ]);
    expect(card?.myBadges.map((chip) => chip.definitionId)).toEqual([
      'def-1',
      'def-2',
    ]);
  });

  it('returns names and chips with no user id', async () => {
    const { manager } = fakeManager(sessionRow(3), [
      winRow({
        winnerId: 'winner-1',
        screenName: 'Ana',
        teamName: 'Glitter Brains',
        definitionId: 'def-1',
        isMine: true,
      }),
    ]);

    const card = await readResultsWinBadges(manager, teamsInput);

    expect(JSON.stringify(card)).not.toContain('user-1');
    expect(collapsed(RESULTS_WIN_ROWS_SQL)).not.toMatch(/"win"\."user_id" AS/);
    expect(collapsed(RESULTS_WIN_ROWS_SQL)).not.toMatch(
      /"winner"\."user_id" AS/,
    );
  });

  it('reads only live winners', () => {
    expect(collapsed(RESULTS_WIN_ROWS_SQL)).toContain(
      '"winner"."revoked_at" IS NULL',
    );
  });

  it('orders the rows by badge name then definition id', () => {
    expect(collapsed(RESULTS_WIN_ROWS_SQL)).toContain(
      'ORDER BY "definition"."name_en" ASC, "definition"."id" ASC',
    );
  });

  it('reads the session game from the session row', () => {
    expect(collapsed(RESULTS_SESSION_GAME_SQL)).toBe(
      'SELECT "event_id", "event_game_number" FROM "quizshow_sessions" WHERE "id" = $1',
    );
  });
});
