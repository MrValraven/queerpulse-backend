import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import { QuizshowImportDto } from './quizshow-import.dto';
import { QuizshowOpenSessionDto } from './quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './quizshow-quiz-input.dto';
import {
  QuizshowAnswerSubmitPayload,
  QuizshowLobbyJoinPayload,
  QuizshowPhaseCommandPayload,
  QuizshowSetScreenMutedPayload,
} from './quizshow-socket-payloads';

type PlainObject = Record<string, unknown>;

async function validateBody<Dto extends object>(
  dtoClass: new () => Dto,
  body: PlainObject,
): Promise<{ instance: Dto; errorCount: number }> {
  const instance = plainToInstance(dtoClass, body, {
    ...VALIDATION_PIPE_OPTIONS.transformOptions,
  });
  const errors = await validate(instance, {
    whitelist: VALIDATION_PIPE_OPTIONS.whitelist,
    forbidNonWhitelisted: VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted,
  });
  return { instance, errorCount: errors.length };
}

const blankText = { en: '', pt: '' };

function buildQuestion(overrides: PlainObject = {}): PlainObject {
  return {
    type: 'multiple_choice',
    prompt: blankText,
    mediaRef: null,
    timeLimitSeconds: null,
    points: 1000,
    options: [
      { id: 'a', text: blankText },
      { id: 'b', text: blankText },
    ],
    answer: null,
    acceptedAnswers: [],
    ...overrides,
  };
}

function buildRound(overrides: PlainObject = {}): PlainObject {
  return {
    kind: 'quiz',
    title: blankText,
    contentLabel: 'none',
    settings: {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    },
    questions: [buildQuestion()],
    ...overrides,
  };
}

function buildQuiz(overrides: PlainObject = {}): PlainObject {
  return {
    expectedUpdatedAt: null,
    title: '',
    languages: 'both',
    screenLanguage: 'en',
    rounds: [buildRound()],
    ...overrides,
  };
}

const sampleUuid = '3f2b8c1e-6a4d-4c8e-9b1a-2d5e7f9a0b3c';

describe('quizshow request bodies', () => {
  it('accepts a draft with blank text and null answers', async () => {
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz(),
    );
    expect(errorCount).toBe(0);
  });

  it('refuses an id on a round or a question', async () => {
    const withRoundId = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ rounds: [buildRound({ id: sampleUuid })] }),
    );
    expect(withRoundId.errorCount).toBeGreaterThan(0);
    const withQuestionId = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({
        rounds: [
          buildRound({ questions: [buildQuestion({ id: sampleUuid })] }),
        ],
      }),
    );
    expect(withQuestionId.errorCount).toBeGreaterThan(0);
  });

  it('refuses an answer key of the wrong type', async () => {
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({
        rounds: [
          buildRound({
            questions: [buildQuestion({ answer: { isTrue: true } })],
          }),
        ],
      }),
    );
    expect(errorCount).toBeGreaterThan(0);
    const matching = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({
        rounds: [
          buildRound({
            questions: [buildQuestion({ answer: { correctIndex: 1 } })],
          }),
        ],
      }),
    );
    expect(matching.errorCount).toBe(0);
  });

  it('keeps eleven rounds valid so the service can answer too many rounds', async () => {
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ rounds: Array.from({ length: 11 }, () => buildRound()) }),
    );
    expect(errorCount).toBe(0);
  });

  it('refuses twenty-one rounds', async () => {
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ rounds: Array.from({ length: 21 }, () => buildRound()) }),
    );
    expect(errorCount).toBeGreaterThan(0);
  });

  it('refuses points outside 500, 1000 and 2000', async () => {
    for (const points of [0, 750, 3000]) {
      const { errorCount } = await validateBody(
        QuizshowQuizInputDto,
        buildQuiz({
          rounds: [buildRound({ questions: [buildQuestion({ points })] })],
        }),
      );
      expect(errorCount).toBeGreaterThan(0);
    }
    const accepted = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({
        rounds: [buildRound({ questions: [buildQuestion({ points: 2000 })] })],
      }),
    );
    expect(accepted.errorCount).toBe(0);
  });

  it('requires a pack key for a pack import and refuses an event slug beside it', async () => {
    const missingKey = await validateBody(QuizshowImportDto, { from: 'pack' });
    expect(missingKey.errorCount).toBeGreaterThan(0);
    const withSlug = await validateBody(QuizshowImportDto, {
      from: 'pack',
      packKey: 'eurovision',
      eventSlug: 'some-event',
    });
    expect(withSlug.errorCount).toBeGreaterThan(0);
    const valid = await validateBody(QuizshowImportDto, {
      from: 'pack',
      packKey: 'eurovision',
    });
    expect(valid.errorCount).toBe(0);
    const eventWithKey = await validateBody(QuizshowImportDto, {
      from: 'event',
      eventSlug: 'some-event',
      packKey: 'eurovision',
    });
    expect(eventWithKey.errorCount).toBeGreaterThan(0);
  });

  it('refuses a team size in solo play', async () => {
    const baseBody = {
      isReviewOn: true,
      notifyGuests: true,
      shouldReplaceResults: false,
    };
    const solo = await validateBody(QuizshowOpenSessionDto, {
      ...baseBody,
      playMode: 'solo',
      maxTeamSize: 4,
    });
    expect(solo.errorCount).toBeGreaterThan(0);
    const soloNull = await validateBody(QuizshowOpenSessionDto, {
      ...baseBody,
      playMode: 'solo',
      maxTeamSize: null,
    });
    expect(soloNull.errorCount).toBe(0);
    const teams = await validateBody(QuizshowOpenSessionDto, {
      ...baseBody,
      playMode: 'teams',
      maxTeamSize: 4,
    });
    expect(teams.errorCount).toBe(0);
  });

  it('trims a screen name and refuses one over thirty characters', async () => {
    const trimmed = await validateBody(QuizshowLobbyJoinPayload, {
      screenName: '  Sam  ',
      isAvatarShown: false,
      hasExtraTime: false,
      team: null,
    });
    expect(trimmed.errorCount).toBe(0);
    expect(trimmed.instance.screenName).toBe('Sam');
    const tooLong = await validateBody(QuizshowLobbyJoinPayload, {
      screenName: 'x'.repeat(31),
      isAvatarShown: false,
      hasExtraTime: false,
      team: null,
    });
    expect(tooLong.errorCount).toBeGreaterThan(0);
  });

  it('requires exactly one of a team id or a new team', async () => {
    const lobbyBody = {
      screenName: 'Sam',
      isAvatarShown: true,
      hasExtraTime: false,
    };
    const neither = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      team: {},
    });
    expect(neither.errorCount).toBeGreaterThan(0);
    const both = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      team: { teamId: sampleUuid, newTeam: { name: 'Owls', colorKey: 'moon' } },
    });
    expect(both.errorCount).toBeGreaterThan(0);
    const existingTeam = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      team: { teamId: sampleUuid },
    });
    expect(existingTeam.errorCount).toBe(0);
    const foundedTeam = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      team: { newTeam: { name: '  Owls ', colorKey: 'moon' } },
    });
    expect(foundedTeam.errorCount).toBe(0);
  });

  it('refuses a phase id that is not a decimal counter', async () => {
    for (const phaseId of ['', 'abc', '-1', '1.5', '1234567890123']) {
      const { errorCount } = await validateBody(QuizshowPhaseCommandPayload, {
        phaseId,
      });
      expect(errorCount).toBeGreaterThan(0);
    }
    const accepted = await validateBody(QuizshowPhaseCommandPayload, {
      phaseId: '42',
    });
    expect(accepted.errorCount).toBe(0);
    const submit = await validateBody(QuizshowAnswerSubmitPayload, {
      phaseId: 'abc',
      questionId: sampleUuid,
      payload: { type: 'true_false', isTrue: true },
    });
    expect(submit.errorCount).toBeGreaterThan(0);
  });

  it('accepts a screen mute payload with a boolean and refuses anything else', async () => {
    const accepted = await validateBody(QuizshowSetScreenMutedPayload, {
      isMuted: true,
    });
    expect(accepted.errorCount).toBe(0);
    const refused = await validateBody(QuizshowSetScreenMutedPayload, {
      isMuted: 'yes',
    });
    expect(refused.errorCount).toBeGreaterThan(0);
  });

  it('refuses a question with no prompt', async () => {
    const question = buildQuestion();
    delete question.prompt;
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ rounds: [buildRound({ questions: [question] })] }),
    );
    expect(errorCount).toBeGreaterThan(0);
  });

  it('refuses an answer submit with no payload', async () => {
    const { errorCount } = await validateBody(QuizshowAnswerSubmitPayload, {
      phaseId: '1',
      questionId: sampleUuid,
    });
    expect(errorCount).toBeGreaterThan(0);
  });

  it('refuses a lobby join with no team key', async () => {
    const { errorCount } = await validateBody(QuizshowLobbyJoinPayload, {
      screenName: 'Sam',
      isAvatarShown: true,
      hasExtraTime: false,
    });
    expect(errorCount).toBeGreaterThan(0);
  });
});
