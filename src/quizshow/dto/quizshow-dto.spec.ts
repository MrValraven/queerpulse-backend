import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
  QuizshowOpenGameSessionDto,
} from './quizshow-game.dto';
import { QuizshowImportDto } from './quizshow-import.dto';
import { QuizshowOpenSessionDto } from './quizshow-open-session.dto';
import { QuizshowQuizInputDto } from './quizshow-quiz-input.dto';
import { QuizshowStaffActionDto } from './quizshow-staff-action.dto';
import {
  QuizshowTemplateInputDto,
  QuizshowTemplateQuizInputDto,
} from './quizshow-template.dto';
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

function buildTemplateInput(overrides: PlainObject = {}): PlainObject {
  return {
    card: {
      title: { en: 'Eurovision night', pt: 'Noite Eurovisão' },
      description: { en: 'Sing along', pt: 'Canta junto' },
    },
    staffNotes: 'Host tips for the final round',
    quiz: buildQuiz({ title: 'Eurovision night' }),
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

  it('accepts a template import and refuses a pack import, a template import without an id and a malformed templateId', async () => {
    const valid = await validateBody(QuizshowImportDto, {
      from: 'template',
      templateId: sampleUuid,
    });
    expect(valid.errorCount).toBe(0);
    const packImport = await validateBody(QuizshowImportDto, {
      from: 'pack',
      packKey: 'eurovision',
    });
    expect(packImport.errorCount).toBeGreaterThan(0);
    const missingId = await validateBody(QuizshowImportDto, {
      from: 'template',
    });
    expect(missingId.errorCount).toBeGreaterThan(0);
    const malformed = await validateBody(QuizshowImportDto, {
      from: 'template',
      templateId: 'not-a-uuid',
    });
    expect(malformed.errorCount).toBeGreaterThan(0);
    const withSlug = await validateBody(QuizshowImportDto, {
      from: 'template',
      templateId: sampleUuid,
      eventSlug: 'some-event',
    });
    expect(withSlug.errorCount).toBeGreaterThan(0);
    const eventWithTemplateId = await validateBody(QuizshowImportDto, {
      from: 'event',
      eventSlug: 'some-event',
      templateId: sampleUuid,
    });
    expect(eventWithTemplateId.errorCount).toBeGreaterThan(0);
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

  it('accepts a game import and refuses one with a templateId or a malformed gameId', async () => {
    const valid = await validateBody(QuizshowImportDto, {
      from: 'game',
      gameId: sampleUuid,
    });
    expect(valid.errorCount).toBe(0);
    const withTemplateId = await validateBody(QuizshowImportDto, {
      from: 'game',
      gameId: sampleUuid,
      templateId: sampleUuid,
    });
    expect(withTemplateId.errorCount).toBeGreaterThan(0);
    const malformed = await validateBody(QuizshowImportDto, {
      from: 'game',
      gameId: 'not-a-uuid',
    });
    expect(malformed.errorCount).toBeGreaterThan(0);
    const missing = await validateBody(QuizshowImportDto, { from: 'game' });
    expect(missing.errorCount).toBeGreaterThan(0);
  });

  it('trims a staff reason and refuses a blank one, one over 500 or a malformed reportId', async () => {
    const trimmed = await validateBody(QuizshowStaffActionDto, {
      reason: '  Hateful questions  ',
      reportId: '00000000-0000-4000-8000-0000000000e1',
    });
    expect(trimmed.errorCount).toBe(0);
    expect(trimmed.instance.reason).toBe('Hateful questions');
    const withoutReport = await validateBody(QuizshowStaffActionDto, {
      reason: 'Spam',
    });
    expect(withoutReport.errorCount).toBe(0);
    const blank = await validateBody(QuizshowStaffActionDto, {
      reason: '   ',
    });
    expect(blank.errorCount).toBeGreaterThan(0);
    const missing = await validateBody(QuizshowStaffActionDto, {});
    expect(missing.errorCount).toBeGreaterThan(0);
    const atLimit = await validateBody(QuizshowStaffActionDto, {
      reason: 'x'.repeat(500),
    });
    expect(atLimit.errorCount).toBe(0);
    const tooLong = await validateBody(QuizshowStaffActionDto, {
      reason: 'x'.repeat(501),
    });
    expect(tooLong.errorCount).toBeGreaterThan(0);
    const malformedReport = await validateBody(QuizshowStaffActionDto, {
      reason: 'Spam',
      reportId: 'report-1',
    });
    expect(malformedReport.errorCount).toBeGreaterThan(0);
  });

  it('trims a create title and refuses a blank one or one over 120', async () => {
    const trimmed = await validateBody(QuizshowCreateGameDto, {
      title: '  Friday night  ',
      source: null,
    });
    expect(trimmed.errorCount).toBe(0);
    expect(trimmed.instance.title).toBe('Friday night');
    const blank = await validateBody(QuizshowCreateGameDto, {
      title: '   ',
      source: null,
    });
    expect(blank.errorCount).toBeGreaterThan(0);
    const tooLong = await validateBody(QuizshowCreateGameDto, {
      title: 'x'.repeat(121),
      source: null,
    });
    expect(tooLong.errorCount).toBeGreaterThan(0);
    const atLimit = await validateBody(QuizshowCreateGameDto, {
      title: 'x'.repeat(120),
      source: null,
    });
    expect(atLimit.errorCount).toBe(0);
  });

  it('accepts a null source and a template source on create and refuses a source of an unknown kind', async () => {
    const nullSource = await validateBody(QuizshowCreateGameDto, {
      title: 'Game',
      source: null,
    });
    expect(nullSource.errorCount).toBe(0);
    const templateSource = await validateBody(QuizshowCreateGameDto, {
      title: 'Game',
      source: { from: 'template', templateId: sampleUuid },
    });
    expect(templateSource.errorCount).toBe(0);
    const unknownKind = await validateBody(QuizshowCreateGameDto, {
      title: 'Game',
      source: { from: 'magazine' },
    });
    expect(unknownKind.errorCount).toBeGreaterThan(0);
    const missingSource = await validateBody(QuizshowCreateGameDto, {
      title: 'Game',
    });
    expect(missingSource.errorCount).toBeGreaterThan(0);
  });

  it('accepts a template source on create', async () => {
    const { errorCount } = await validateBody(QuizshowCreateGameDto, {
      title: 'Game',
      source: { from: 'template', templateId: sampleUuid },
    });
    expect(errorCount).toBe(0);
  });

  it('trims the card fields and refuses a title over 120, a description over 300 and staff notes over 20000', async () => {
    const trimmed = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        card: {
          title: { en: '  Eurovision night  ', pt: '  Noite Eurovisão  ' },
          description: { en: '  Sing along  ', pt: '  Canta junto  ' },
        },
      }),
    );
    expect(trimmed.errorCount).toBe(0);
    expect(trimmed.instance.card.title.en).toBe('Eurovision night');
    expect(trimmed.instance.card.title.pt).toBe('Noite Eurovisão');
    expect(trimmed.instance.card.description.en).toBe('Sing along');
    expect(trimmed.instance.card.description.pt).toBe('Canta junto');
    const titleAtLimit = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        card: {
          title: { en: 'x'.repeat(120), pt: 'y'.repeat(120) },
          description: { en: 'x'.repeat(300), pt: 'y'.repeat(300) },
        },
        staffNotes: 'n'.repeat(20000),
      }),
    );
    expect(titleAtLimit.errorCount).toBe(0);
    const titleTooLong = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        card: {
          title: { en: 'x'.repeat(121), pt: '' },
          description: blankText,
        },
      }),
    );
    expect(titleTooLong.errorCount).toBeGreaterThan(0);
    const descriptionTooLong = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        card: {
          title: blankText,
          description: { en: '', pt: 'y'.repeat(301) },
        },
      }),
    );
    expect(descriptionTooLong.errorCount).toBeGreaterThan(0);
    const notesTooLong = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({ staffNotes: 'n'.repeat(20001) }),
    );
    expect(notesTooLong.errorCount).toBeGreaterThan(0);
  });

  it('refuses a blank template quiz title and a missing card, notes or quiz', async () => {
    const valid = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput(),
    );
    expect(valid.errorCount).toBe(0);
    const blankQuizTitle = await validateBody(
      QuizshowTemplateQuizInputDto,
      buildQuiz({ title: '   ' }),
    );
    expect(blankQuizTitle.errorCount).toBeGreaterThan(0);
    const blankQuizTitleInBody = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({ quiz: buildQuiz({ title: '' }) }),
    );
    expect(blankQuizTitleInBody.errorCount).toBeGreaterThan(0);
    for (const missingField of ['card', 'staffNotes', 'quiz']) {
      const body = buildTemplateInput();
      delete body[missingField];
      const refused = await validateBody(QuizshowTemplateInputDto, body);
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts an adults round in a template quiz', async () => {
    const { errorCount } = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        quiz: buildQuiz({
          title: 'After dark',
          rounds: [buildRound({ contentLabel: 'adults' })],
        }),
      }),
    );
    expect(errorCount).toBe(0);
  });

  it('requires isAdultsOnly on a game PUT and refuses a blank title there', async () => {
    const valid = await validateBody(
      QuizshowGameInputDto,
      buildQuiz({ title: 'Game', isAdultsOnly: false }),
    );
    expect(valid.errorCount).toBe(0);
    const missingSwitch = await validateBody(
      QuizshowGameInputDto,
      buildQuiz({ title: 'Game' }),
    );
    expect(missingSwitch.errorCount).toBeGreaterThan(0);
    const blankTitle = await validateBody(
      QuizshowGameInputDto,
      buildQuiz({ title: '  ', isAdultsOnly: true }),
    );
    expect(blankTitle.errorCount).toBeGreaterThan(0);
  });

  it('refuses notifyGuests true on a game session open', async () => {
    const baseBody = {
      playMode: 'solo',
      maxTeamSize: null,
      isReviewOn: true,
      shouldReplaceResults: false,
    };
    const accepted = await validateBody(QuizshowOpenGameSessionDto, {
      ...baseBody,
      notifyGuests: false,
    });
    expect(accepted.errorCount).toBe(0);
    const refused = await validateBody(QuizshowOpenGameSessionDto, {
      ...baseBody,
      notifyGuests: true,
    });
    expect(refused.errorCount).toBeGreaterThan(0);
  });

  it('accepts lobby:join with and without hasAcceptedAdultContent and refuses a non-boolean', async () => {
    const lobbyBody = {
      screenName: 'Sam',
      isAvatarShown: true,
      hasExtraTime: false,
      team: null,
    };
    const without = await validateBody(QuizshowLobbyJoinPayload, lobbyBody);
    expect(without.errorCount).toBe(0);
    const withConsent = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      hasAcceptedAdultContent: true,
    });
    expect(withConsent.errorCount).toBe(0);
    const nonBoolean = await validateBody(QuizshowLobbyJoinPayload, {
      ...lobbyBody,
      hasAcceptedAdultContent: 'yes',
    });
    expect(nonBoolean.errorCount).toBeGreaterThan(0);
  });
});
