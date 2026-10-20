import { DataSource } from 'typeorm';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { QuizshowPlaysExportContributor } from './data-export-contributors-quizshow';
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
