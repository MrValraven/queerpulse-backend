import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import {
  QuizshowGamesExportContributor,
  QuizshowPlaysExportContributor,
} from './data-export-contributors-quizshow';
import { EXPORT_CSV_CATEGORIES } from './export-archive';

const PLAYER_ID = '76000000-0000-4000-8000-000000000001';
const QUESTION_ID = '76000000-0000-4000-8000-000000000002';
const UNKNOWN_QUESTION_ID = '76000000-0000-4000-8000-000000000003';
const STARTED = new Date('2026-10-10T20:00:00.000Z');
const ANSWERED = new Date('2026-10-10T20:05:00.000Z');
const VOTED = new Date('2026-10-10T20:06:00.000Z');

const SNAPSHOT = {
  title: 'Friday quiz',
  rounds: [
    {
      questions: [
        {
          id: QUESTION_ID,
          prompt: { en: 'Capital of Portugal?', pt: 'Capital de Portugal?' },
        },
      ],
    },
  ],
};

function playRow(overrides: Record<string, unknown> = {}) {
  return {
    player_id: PLAYER_ID,
    event_title: 'Quiz night',
    event_slug: 'quiz-night',
    quiz_title: 'Friday quiz',
    started_at: STARTED,
    screen_name: 'Ana',
    team_name: 'Rainbow',
    score: 2500,
    is_removed: false,
    quiz_snapshot: SNAPSHOT,
    ...overrides,
  };
}

describe('QuizshowPlaysExportContributor', () => {
  let query: jest.Mock;
  let contributor: QuizshowPlaysExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new QuizshowPlaysExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('exports one row per session played with answers and votes', async () => {
    query
      .mockResolvedValueOnce([playRow()])
      .mockResolvedValueOnce([
        {
          player_id: PLAYER_ID,
          question_id: QUESTION_ID,
          payload: { type: 'type_answer', text: 'Lisbon' },
          points_awarded: 900,
          received_at: ANSWERED,
        },
      ])
      .mockResolvedValueOnce([
        {
          voter_player_id: PLAYER_ID,
          question_id: QUESTION_ID,
          is_for_truth: true,
          created_at: VOTED,
        },
      ]);
    await expect(contributor.buildContribution('member-1')).resolves.toEqual([
      {
        eventTitle: 'Quiz night',
        eventSlug: 'quiz-night',
        quizTitle: 'Friday quiz',
        startedAt: '2026-10-10T20:00:00.000Z',
        screenName: 'Ana',
        teamName: 'Rainbow',
        score: 2500,
        wasRemoved: false,
        answers: [
          {
            questionPrompt: {
              en: 'Capital of Portugal?',
              pt: 'Capital de Portugal?',
            },
            answer: { type: 'type_answer', text: 'Lisbon' },
            pointsAwarded: 900,
            receivedAt: '2026-10-10T20:05:00.000Z',
          },
        ],
        votes: [
          {
            questionPrompt: {
              en: 'Capital of Portugal?',
              pt: 'Capital de Portugal?',
            },
            votedForTruth: true,
            votedAt: '2026-10-10T20:06:00.000Z',
          },
        ],
      },
    ]);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('names the question from the frozen quiz', async () => {
    query
      .mockResolvedValueOnce([playRow({ is_removed: true })])
      .mockResolvedValueOnce([
        {
          player_id: PLAYER_ID,
          question_id: QUESTION_ID,
          payload: { type: 'true_false', isTrue: true },
          points_awarded: 0,
          received_at: ANSWERED,
        },
        {
          player_id: PLAYER_ID,
          question_id: UNKNOWN_QUESTION_ID,
          payload: { type: 'true_false', isTrue: false },
          points_awarded: 0,
          received_at: VOTED,
        },
      ])
      .mockResolvedValueOnce([]);
    const plays = await contributor.buildContribution('member-1');
    expect(plays).toHaveLength(1);
    const play = plays[0]!;
    expect(play.wasRemoved).toBe(true);
    expect(play.answers.map((answer) => answer.questionPrompt)).toEqual([
      { en: 'Capital of Portugal?', pt: 'Capital de Portugal?' },
      null,
    ]);
    expect(play.votes).toEqual([]);
  });

  it('exports nothing for a member who never played', async () => {
    query.mockResolvedValueOnce([]);
    await expect(contributor.buildContribution('member-1')).resolves.toEqual(
      [],
    );
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("leaves other members' answer text out of the votes", async () => {
    query
      .mockResolvedValueOnce([playRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          voter_player_id: PLAYER_ID,
          question_id: QUESTION_ID,
          is_for_truth: false,
          created_at: VOTED,
        },
      ]);
    const plays = await contributor.buildContribution('member-1');
    expect(plays).toHaveLength(1);
    const play = plays[0]!;
    expect(play.answers).toEqual([]);
    expect(play.votes).toHaveLength(1);
    expect(Object.keys(play.votes[0]!).sort()).toEqual([
      'questionPrompt',
      'votedAt',
      'votedForTruth',
    ]);
    expect(play.votes[0]!).not.toHaveProperty('text');
    const voteSql = String((query.mock.calls[2] as unknown[])[0]);
    expect(voteSql).not.toContain('quizshow_answers');
  });

  it('is registered with a matching archive key', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      QuizshowPlaysExportContributor,
    );
    expect(EXPORT_CSV_CATEGORIES).toContain('quizshowPlays');
  });
});

describe('QuizshowPlaysExportContributor for games', () => {
  let query: jest.Mock;
  let contributor: QuizshowPlaysExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new QuizshowPlaysExportContributor({
      query,
    } as unknown as DataSource);
  });

  it('exports a play of a game with null event fields and the game title', async () => {
    query
      .mockResolvedValueOnce([
        playRow({
          event_title: null,
          event_slug: null,
          quiz_title: 'Pub game',
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const plays = await contributor.buildContribution('member-1');
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({
      eventTitle: null,
      eventSlug: null,
      quizTitle: 'Pub game',
    });
  });

  it('selects plays with a left join on events', async () => {
    query.mockResolvedValueOnce([]);
    await contributor.buildContribution('member-1');
    const playSql = String((query.mock.calls[0] as unknown[])[0]);
    expect(playSql).toContain('LEFT JOIN "events"');
    expect(playSql.replace('LEFT JOIN "events"', '')).not.toContain(
      'JOIN "events"',
    );
  });
});

describe('QuizshowGamesExportContributor', () => {
  const GAME_ID = '77000000-0000-4000-8000-000000000001';
  const ROUND_ONE_ID = '77000000-0000-4000-8000-000000000011';
  const ROUND_TWO_ID = '77000000-0000-4000-8000-000000000012';
  const CREATED = new Date('2026-10-01T10:00:00.000Z');
  const UPDATED = new Date('2026-10-02T10:00:00.000Z');
  let query: jest.Mock;
  let contributor: QuizshowGamesExportContributor;

  beforeEach(() => {
    query = jest.fn();
    contributor = new QuizshowGamesExportContributor({
      query,
    } as unknown as DataSource);
  });

  it("exports the member's own games with rounds and questions in position order", async () => {
    query
      .mockResolvedValueOnce([
        {
          id: GAME_ID,
          title: 'Pub game',
          is_adults_only: true,
          languages: 'both',
          screen_language: 'en',
          created_at: CREATED,
          updated_at: UPDATED,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: ROUND_ONE_ID,
          quiz_id: GAME_ID,
          kind: 'standard',
          title_en: 'Warm up',
          title_pt: 'Aquecimento',
          content_label: 'none',
        },
        {
          id: ROUND_TWO_ID,
          quiz_id: GAME_ID,
          kind: 'standard',
          title_en: 'Finale',
          title_pt: 'Final',
          content_label: 'adults',
        },
      ])
      .mockResolvedValueOnce([
        {
          round_id: ROUND_ONE_ID,
          type: 'type_answer',
          prompt_en: 'First?',
          prompt_pt: 'Primeiro?',
          media_ref: null,
          options: [],
          answer: { text: 'one' },
          accepted_answers: ['uno'],
        },
        {
          round_id: ROUND_ONE_ID,
          type: 'true_false',
          prompt_en: 'Second?',
          prompt_pt: 'Segundo?',
          media_ref: 'media/key.png',
          options: [],
          answer: { isTrue: true },
          accepted_answers: [],
        },
      ]);
    const games = await contributor.buildContribution('member-1');
    expect(games).toEqual([
      {
        title: 'Pub game',
        isAdultsOnly: true,
        languages: 'both',
        screenLanguage: 'en',
        createdAt: '2026-10-01T10:00:00.000Z',
        updatedAt: '2026-10-02T10:00:00.000Z',
        rounds: [
          {
            title: { en: 'Warm up', pt: 'Aquecimento' },
            kind: 'standard',
            contentLabel: 'none',
            questions: [
              {
                type: 'type_answer',
                prompt: { en: 'First?', pt: 'Primeiro?' },
                options: [],
                answer: { text: 'one' },
                acceptedAnswers: ['uno'],
                mediaRef: null,
              },
              {
                type: 'true_false',
                prompt: { en: 'Second?', pt: 'Segundo?' },
                options: [],
                answer: { isTrue: true },
                acceptedAnswers: [],
                mediaRef: 'media/key.png',
              },
            ],
          },
          {
            title: { en: 'Finale', pt: 'Final' },
            kind: 'standard',
            contentLabel: 'adults',
            questions: [],
          },
        ],
      },
    ]);
    const roundSql = String((query.mock.calls[1] as unknown[])[0]);
    const questionSql = String((query.mock.calls[2] as unknown[])[0]);
    expect(roundSql).toContain('ORDER BY "round"."position"');
    expect(questionSql).toContain('ORDER BY "question"."position"');
  });

  it('reads only games owned by the member', async () => {
    query.mockResolvedValueOnce([]);
    await expect(contributor.buildContribution('member-1')).resolves.toEqual(
      [],
    );
    const call = query.mock.calls[0] as [string, unknown[]];
    expect(call[0]).toContain('"owner_user_id" = $1');
    expect(call[1]).toEqual(['member-1']);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('registers under the events category and the quizshowGames key, listed after quizshowPlays', () => {
    expect(contributor.category).toBe('events');
    expect(contributor.archiveKey).toBe('quizshowGames');
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toContain(
      QuizshowGamesExportContributor,
    );
    expect(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(QuizshowGamesExportContributor),
    ).toBeGreaterThan(
      NEW_DOMAIN_EXPORT_CONTRIBUTORS.indexOf(QuizshowPlaysExportContributor),
    );
    expect(EXPORT_CSV_CATEGORIES.indexOf('quizshowGames')).toBe(
      EXPORT_CSV_CATEGORIES.indexOf('quizshowPlays') + 1,
    );
  });
});
