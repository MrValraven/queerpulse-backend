import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  QuizshowCreateGameDto,
  QuizshowGameInputDto,
  QuizshowOpenGameSessionDto,
} from './quizshow-game.dto';
import { QUIZSHOW_WHEEL_SETTINGS_DEFAULTS } from '../quizshow.contract';
import { QuizshowImportDto } from './quizshow-import.dto';
import { QuizshowOpenSessionDto } from './quizshow-open-session.dto';
import {
  QuizshowQuizInputDto,
  QuizshowRoundSettingsDto,
} from './quizshow-quiz-input.dto';
import { QuizshowStaffActionDto } from './quizshow-staff-action.dto';
import {
  QuizshowTemplateInputDto,
  QuizshowTemplateQuizInputDto,
} from './quizshow-template.dto';
import {
  QuizshowAcceptAnswerPayload,
  QuizshowAdjustPointsPayload,
  QuizshowAnswerSubmitPayload,
  QuizshowAttachPayload,
  QuizshowChangeCorrectAnswerPayload,
  QuizshowCreateTeamsPayload,
  QuizshowJokerPayload,
  QuizshowLeavePayload,
  QuizshowLobbyJoinPayload,
  QuizshowMovePlayerPayload,
  QuizshowNotifyGuestsPayload,
  QuizshowPairDevicePayload,
  QuizshowPhaseCommandPayload,
  QuizshowReactionPayload,
  QuizshowRemovePlayerPayload,
  QuizshowRenamePlayerPayload,
  QuizshowSessionPingPayload,
  QuizshowSetAutoAdvancePayload,
  QuizshowSetJoinLockPayload,
  QuizshowSetScreenMutedPayload,
  QuizshowUnpairDevicePayload,
} from './quizshow-socket-payloads';

type PlainObject = Record<string, unknown>;

async function validateBody<Dto extends object>(
  dtoClass: new () => Dto,
  body: PlainObject,
): Promise<{
  instance: Dto;
  errorCount: number;
  errorProperties: string[];
  constraintNames: string[];
}> {
  const instance = plainToInstance(dtoClass, body, {
    ...VALIDATION_PIPE_OPTIONS.transformOptions,
  });
  const errors = await validate(instance, {
    whitelist: VALIDATION_PIPE_OPTIONS.whitelist,
    forbidNonWhitelisted: VALIDATION_PIPE_OPTIONS.forbidNonWhitelisted,
  });
  return {
    instance,
    errorCount: errors.length,
    errorProperties: errors.map((error) => error.property),
    constraintNames: errors.flatMap((error) =>
      Object.keys(error.constraints ?? {}),
    ),
  };
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
      ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
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
            questions: [buildQuestion({ answer: { correctIndexes: [1] } })],
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
      isPractice: false,
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
      isPractice: false,
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

  const baseRoundSettings = {
    timeLimitSeconds: 20,
    isSpeedBonusOn: true,
    isJokerAllowed: true,
    writeSeconds: 60,
    voteSeconds: 30,
  };

  it('accepts round settings without the wheel fields', async () => {
    const settingsOnly = await validateBody(
      QuizshowRoundSettingsDto,
      baseRoundSettings,
    );
    expect(settingsOnly.errorCount).toBe(0);
    const insideAQuiz = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ rounds: [buildRound({ settings: baseRoundSettings })] }),
    );
    expect(insideAQuiz.errorCount).toBe(0);
  });

  it('accepts every wheel bonus, both picks, an Auto and a fixed slice count', async () => {
    for (const wheelBonus of [0, 250, 500, 1000]) {
      const result = await validateBody(QuizshowRoundSettingsDto, {
        ...baseRoundSettings,
        wheelBonus,
      });
      expect(result.errorCount).toBe(0);
    }
    for (const wheelPick of ['round', 'question']) {
      const result = await validateBody(QuizshowRoundSettingsDto, {
        ...baseRoundSettings,
        wheelPick,
      });
      expect(result.errorCount).toBe(0);
    }
    for (const sliceCount of [null, 2, 8]) {
      const result = await validateBody(QuizshowRoundSettingsDto, {
        ...baseRoundSettings,
        sliceCount,
      });
      expect(result.errorCount).toBe(0);
    }
  });

  it('refuses an unknown bonus, pick or slice count', async () => {
    const refusedFields: Array<[string, unknown]> = [
      ['wheelBonus', 300],
      ['wheelPick', 'player'],
      ['sliceCount', 1],
      ['sliceCount', 9],
      ['sliceCount', 2.5],
    ];
    for (const [property, value] of refusedFields) {
      const result = await validateBody(QuizshowRoundSettingsDto, {
        ...baseRoundSettings,
        [property]: value,
      });
      expect(result.errorProperties).toEqual([property]);
    }
  });

  it('accepts a wheel round kind', async () => {
    const { errorCount } = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({
        rounds: [buildRound({ kind: 'wheel', questions: [] })],
      }),
    );
    expect(errorCount).toBe(0);
  });

  it('takes a joker on any of the 13 round rows', async () => {
    const lastRow = await validateBody(QuizshowJokerPayload, {
      roundIndex: 12,
    });
    expect(lastRow.errorCount).toBe(0);
    const pastTheRows = await validateBody(QuizshowJokerPayload, {
      roundIndex: 13,
    });
    expect(pastTheRows.errorProperties).toEqual(['roundIndex']);
    expect(pastTheRows.constraintNames).toEqual(['max']);
  });
});

describe('quizshow v2 quiz input fields', () => {
  function quizWithQuestion(question: PlainObject): PlainObject {
    return buildQuiz({ rounds: [buildRound({ questions: [question] })] });
  }

  it('accepts multiple choice correctIndexes and refuses a bare number, too many entries or a negative index', async () => {
    for (const correctIndexes of [[], [0], [0, 1]]) {
      const accepted = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(buildQuestion({ answer: { correctIndexes } })),
      );
      expect(accepted.errorCount).toBe(0);
    }
    const refusedAnswers: PlainObject[] = [
      { correctIndexes: [0, 1, 2, 3, 4] },
      { correctIndexes: [-1] },
      { correctIndexes: [0.5] },
      { correctIndexes: 1 },
    ];
    for (const answer of refusedAnswers) {
      const refused = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(buildQuestion({ answer })),
      );
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts a closest answer with a tolerance and refuses one with a bad mode or amount', async () => {
    const closestQuestion = (answer: PlainObject): PlainObject =>
      buildQuestion({ type: 'closest_number', options: [], answer });
    const accepted = await validateBody(
      QuizshowQuizInputDto,
      quizWithQuestion(
        closestQuestion({
          value: 1990,
          tolerance: { mode: 'percent', amount: 10 },
        }),
      ),
    );
    expect(accepted.errorCount).toBe(0);
    const refusedAnswers: PlainObject[] = [
      { value: 1990, tolerance: { mode: 'relative', amount: 10 } },
      { value: 1990, tolerance: { mode: 'absolute', amount: 'ten' } },
      { value: 1990, tolerance: { mode: 'exact' } },
      { value: 1990, tolerance: { mode: 'exact', amount: 0, unit: 'years' } },
    ];
    for (const answer of refusedAnswers) {
      const refused = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(closestQuestion(answer)),
      );
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts the answer shapes a studio page cached before v2 saves and refuses them mixed or malformed', async () => {
    const closestQuestion = (answer: PlainObject): PlainObject =>
      buildQuestion({ type: 'closest_number', options: [], answer });
    const acceptedQuestions: PlainObject[] = [
      buildQuestion({ answer: { correctIndex: 1 } }),
      closestQuestion({ value: 1990 }),
    ];
    for (const question of acceptedQuestions) {
      const accepted = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(question),
      );
      expect(accepted.errorCount).toBe(0);
    }
    const refusedQuestions: PlainObject[] = [
      buildQuestion({ answer: { correctIndex: 1, correctIndexes: [1] } }),
      buildQuestion({ answer: { correctIndex: -1 } }),
      buildQuestion({ answer: { correctIndex: 0.5 } }),
      buildQuestion({ answer: { correctIndex: '1' } }),
      closestQuestion({ value: 1990, correctIndex: 0 }),
      closestQuestion({ tolerance: { mode: 'percent', amount: 10 } }),
    ];
    for (const question of refusedQuestions) {
      const refused = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(question),
      );
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts a poll with a null answer and refuses a poll with any answer', async () => {
    const accepted = await validateBody(
      QuizshowQuizInputDto,
      quizWithQuestion(buildQuestion({ type: 'poll', answer: null })),
    );
    expect(accepted.errorCount).toBe(0);
    for (const answer of [{}, { correctIndexes: [0] }]) {
      const refused = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(buildQuestion({ type: 'poll', answer })),
      );
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts the picture, note and unit fields at their limits and refuses them past the limits', async () => {
    const accepted = await validateBody(
      QuizshowQuizInputDto,
      quizWithQuestion(
        buildQuestion({
          mediaAlt: { en: 'a'.repeat(200), pt: '' },
          mediaReveal: 'slow',
          revealNote: { en: '', pt: 'n'.repeat(200) },
          numberUnit: { en: 'u'.repeat(20), pt: 'anos' },
        }),
      ),
    );
    expect(accepted.errorCount).toBe(0);
    const refusedFields: PlainObject[] = [
      { mediaAlt: { en: 'a'.repeat(201), pt: '' } },
      { mediaAlt: { en: '' } },
      { revealNote: { en: 'n'.repeat(201), pt: '' } },
      { numberUnit: { en: '', pt: 'u'.repeat(21) } },
      { mediaReveal: 'fade' },
    ];
    for (const fields of refusedFields) {
      const refused = await validateBody(
        QuizshowQuizInputDto,
        quizWithQuestion(buildQuestion(fields)),
      );
      expect(refused.errorCount).toBeGreaterThan(0);
    }
  });

  it('accepts warm-up and talk time settings and refuses a non-boolean warm-up or 15 talk seconds', async () => {
    const settings = {
      timeLimitSeconds: 20,
      isSpeedBonusOn: true,
      isJokerAllowed: true,
      writeSeconds: 60,
      voteSeconds: 30,
    };
    for (const talkSeconds of [0, 10, 20, 30]) {
      const accepted = await validateBody(QuizshowRoundSettingsDto, {
        ...settings,
        isWarmUp: true,
        talkSeconds,
      });
      expect(accepted.errorCount).toBe(0);
    }
    const refusedFields: Array<[string, unknown]> = [
      ['isWarmUp', 'yes'],
      ['talkSeconds', 15],
    ];
    for (const [property, value] of refusedFields) {
      const refused = await validateBody(QuizshowRoundSettingsDto, {
        ...settings,
        [property]: value,
      });
      expect(refused.errorProperties).toEqual([property]);
    }
  });

  it('accepts screenLanguage both and refuses an unknown screen language', async () => {
    const both = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ screenLanguage: 'both' }),
    );
    expect(both.errorCount).toBe(0);
    const unknown = await validateBody(
      QuizshowQuizInputDto,
      buildQuiz({ screenLanguage: 'fr' }),
    );
    expect(unknown.errorProperties).toEqual(['screenLanguage']);
  });
});

describe('quizshow v2 open, import and template bodies', () => {
  const openBody = {
    playMode: 'solo',
    maxTeamSize: null,
    isReviewOn: true,
    notifyGuests: false,
    shouldReplaceResults: false,
    isPractice: true,
  };

  it('requires a boolean isPractice on both open bodies', async () => {
    for (const dtoClass of [
      QuizshowOpenSessionDto,
      QuizshowOpenGameSessionDto,
    ]) {
      const accepted = await validateBody(dtoClass, openBody);
      expect(accepted.errorCount).toBe(0);
      const withoutPractice: PlainObject = { ...openBody };
      delete withoutPractice.isPractice;
      const missing = await validateBody(dtoClass, withoutPractice);
      expect(missing.errorProperties).toEqual(['isPractice']);
      const nonBoolean = await validateBody(dtoClass, {
        ...openBody,
        isPractice: 'yes',
      });
      expect(nonBoolean.errorProperties).toEqual(['isPractice']);
    }
  });

  it('accepts a missing, null or uuid rematchOfSessionId and refuses a malformed one', async () => {
    for (const rematchOfSessionId of [undefined, null, sampleUuid]) {
      const accepted = await validateBody(QuizshowOpenSessionDto, {
        ...openBody,
        rematchOfSessionId,
      });
      expect(accepted.errorCount).toBe(0);
    }
    const malformed = await validateBody(QuizshowOpenGameSessionDto, {
      ...openBody,
      rematchOfSessionId: 'session-1',
    });
    expect(malformed.errorProperties).toEqual(['rematchOfSessionId']);
  });

  it('accepts an append import with rows and a token and refuses a bad mode, row list or token', async () => {
    const source = { from: 'game', gameId: sampleUuid };
    const append = await validateBody(QuizshowImportDto, {
      ...source,
      mode: 'append',
      roundIndexes: [0, 2],
      expectedUpdatedAt: '2026-11-24T10:00:00.000Z',
    });
    expect(append.errorCount).toBe(0);
    const nulls = await validateBody(QuizshowImportDto, {
      ...source,
      mode: 'replace',
      roundIndexes: null,
      expectedUpdatedAt: null,
    });
    expect(nulls.errorCount).toBe(0);
    const refusedFields: Array<[string, unknown]> = [
      ['mode', 'merge'],
      ['roundIndexes', [-1]],
      ['roundIndexes', [1.5]],
      ['roundIndexes', Array.from({ length: 14 }, (_value, index) => index)],
      ['roundIndexes', 3],
      ['expectedUpdatedAt', 'yesterday'],
    ];
    for (const [property, value] of refusedFields) {
      const refused = await validateBody(QuizshowImportDto, {
        ...source,
        [property]: value,
      });
      expect(refused.errorProperties).toEqual([property]);
    }
  });

  it('trims a template change note, accepts a body without one and refuses one over 300', async () => {
    const trimmed = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        changeNote: { en: '  New final round  ', pt: '  Nova ronda final ' },
      }),
    );
    expect(trimmed.errorCount).toBe(0);
    expect(trimmed.instance.changeNote?.en).toBe('New final round');
    expect(trimmed.instance.changeNote?.pt).toBe('Nova ronda final');
    const atLimit = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        changeNote: { en: 'x'.repeat(300), pt: '' },
      }),
    );
    expect(atLimit.errorCount).toBe(0);
    const tooLong = await validateBody(
      QuizshowTemplateInputDto,
      buildTemplateInput({
        changeNote: { en: '', pt: 'y'.repeat(301) },
      }),
    );
    expect(tooLong.errorProperties).toEqual(['changeNote']);
  });
});

describe('quizshow v2 socket payloads', () => {
  it('accepts an empty leave, ping and notify payload and refuses any key on them', async () => {
    for (const dtoClass of [
      QuizshowLeavePayload,
      QuizshowSessionPingPayload,
      QuizshowNotifyGuestsPayload,
    ]) {
      const accepted = await validateBody(dtoClass, {});
      expect(accepted.errorCount).toBe(0);
      const unknownKey = await validateBody(dtoClass, { playerId: sampleUuid });
      expect(unknownKey.errorProperties).toEqual(['playerId']);
    }
  });

  it('accepts every reaction id and refuses an unknown one', async () => {
    for (const reactionId of [
      'heart',
      'fire',
      'clap',
      'laugh',
      'wow',
      'party',
    ]) {
      const accepted = await validateBody(QuizshowReactionPayload, {
        reactionId,
      });
      expect(accepted.errorCount).toBe(0);
    }
    const refused = await validateBody(QuizshowReactionPayload, {
      reactionId: 'thumbs',
    });
    expect(refused.errorProperties).toEqual(['reactionId']);
  });

  it('accepts an accepted answer of 1..80 characters and refuses an empty or longer one', async () => {
    const body = { phaseId: '7', questionId: sampleUuid };
    for (const normalisedText of ['a', 'x'.repeat(80)]) {
      const accepted = await validateBody(QuizshowAcceptAnswerPayload, {
        ...body,
        normalisedText,
      });
      expect(accepted.errorCount).toBe(0);
    }
    for (const normalisedText of ['', 'x'.repeat(81)]) {
      const refused = await validateBody(QuizshowAcceptAnswerPayload, {
        ...body,
        normalisedText,
      });
      expect(refused.errorProperties).toEqual(['normalisedText']);
    }
  });

  it('accepts a multiple choice or true or false key change and refuses a mixed, empty or unknown one', async () => {
    const body = { phaseId: '7', questionId: sampleUuid };
    const acceptedAnswers: PlainObject[] = [
      { type: 'multiple_choice', correctIndexes: [0, 2] },
      { type: 'true_false', isTrue: false },
    ];
    for (const answer of acceptedAnswers) {
      const accepted = await validateBody(QuizshowChangeCorrectAnswerPayload, {
        ...body,
        answer,
      });
      expect(accepted.errorCount).toBe(0);
    }
    const refusedAnswers: PlainObject[] = [
      { type: 'multiple_choice', correctIndexes: [] },
      { type: 'multiple_choice', correctIndexes: [0, 1, 2, 3, 4] },
      { type: 'multiple_choice', correctIndexes: [0], isTrue: true },
      { type: 'true_false' },
      { type: 'true_false', isTrue: true, correctIndexes: [0] },
      { type: 'order', orderedIds: ['a'] },
    ];
    for (const answer of refusedAnswers) {
      const refused = await validateBody(QuizshowChangeCorrectAnswerPayload, {
        ...body,
        answer,
      });
      expect(refused.errorProperties).toEqual(['answer']);
    }
  });

  it('accepts a whole non-zero delta up to 5000 either way and refuses 0, 5001 or a fraction', async () => {
    const body = { entrantId: sampleUuid, requestId: sampleUuid };
    for (const delta of [250, -5000, 5000]) {
      const accepted = await validateBody(QuizshowAdjustPointsPayload, {
        ...body,
        delta,
      });
      expect(accepted.errorCount).toBe(0);
    }
    for (const delta of [0, 5001, -5001, 1.5]) {
      const refused = await validateBody(QuizshowAdjustPointsPayload, {
        ...body,
        delta,
      });
      expect(refused.errorProperties).toEqual(['delta']);
    }
    const badRequestId = await validateBody(QuizshowAdjustPointsPayload, {
      ...body,
      delta: 10,
      requestId: 'request-1',
    });
    expect(badRequestId.errorProperties).toEqual(['requestId']);
  });

  it('accepts a pairing code from 2 to 9 and refuses one with a 1 or of the wrong length', async () => {
    const accepted = await validateBody(QuizshowPairDevicePayload, {
      pairingCode: '234567',
    });
    expect(accepted.errorCount).toBe(0);
    for (const pairingCode of ['123456', '23456', '2345678', 234567]) {
      const refused = await validateBody(QuizshowPairDevicePayload, {
        pairingCode,
      });
      expect(refused.errorProperties).toEqual(['pairingCode']);
    }
  });

  it('accepts an unpair by pairing id and refuses a malformed one', async () => {
    const accepted = await validateBody(QuizshowUnpairDevicePayload, {
      pairingId: sampleUuid,
    });
    expect(accepted.errorCount).toBe(0);
    const refused = await validateBody(QuizshowUnpairDevicePayload, {
      pairingId: 'pairing-1',
    });
    expect(refused.errorProperties).toEqual(['pairingId']);
  });

  it('accepts 1 to 24 team names and refuses none, 25, an empty one or one over 40', async () => {
    for (const names of [
      ['Owls'],
      Array.from({ length: 24 }, (_value, index) => `Team ${index + 1}`),
    ]) {
      const accepted = await validateBody(QuizshowCreateTeamsPayload, {
        names,
      });
      expect(accepted.errorCount).toBe(0);
    }
    for (const names of [
      [],
      Array.from({ length: 25 }, (_value, index) => `Team ${index + 1}`),
      ['Owls', ''],
      ['x'.repeat(41)],
      ['Owls', 7],
    ]) {
      const refused = await validateBody(QuizshowCreateTeamsPayload, {
        names,
      });
      expect(refused.errorProperties).toEqual(['names']);
    }
  });

  it('accepts a host rename of 1..30 characters and refuses an empty or longer one', async () => {
    const accepted = await validateBody(QuizshowRenamePlayerPayload, {
      playerId: sampleUuid,
      screenName: 'Sam',
    });
    expect(accepted.errorCount).toBe(0);
    for (const screenName of ['', 'x'.repeat(31)]) {
      const refused = await validateBody(QuizshowRenamePlayerPayload, {
        playerId: sampleUuid,
        screenName,
      });
      expect(refused.errorProperties).toEqual(['screenName']);
    }
  });

  it('accepts a move to a team id and refuses a malformed team id', async () => {
    const accepted = await validateBody(QuizshowMovePlayerPayload, {
      playerId: sampleUuid,
      teamId: sampleUuid,
    });
    expect(accepted.errorCount).toBe(0);
    const refused = await validateBody(QuizshowMovePlayerPayload, {
      playerId: sampleUuid,
      teamId: 'team-1',
    });
    expect(refused.errorProperties).toEqual(['teamId']);
  });

  it('accepts a remove with and without canRejoin and refuses a non-boolean', async () => {
    for (const extra of [{}, { canRejoin: true }, { canRejoin: false }]) {
      const accepted = await validateBody(QuizshowRemovePlayerPayload, {
        playerId: sampleUuid,
        ...extra,
      });
      expect(accepted.errorCount).toBe(0);
    }
    const refused = await validateBody(QuizshowRemovePlayerPayload, {
      playerId: sampleUuid,
      canRejoin: 'yes',
    });
    expect(refused.errorProperties).toEqual(['canRejoin']);
  });

  it('accepts boolean join lock and auto-advance switches and refuses anything else', async () => {
    const lockOn = await validateBody(QuizshowSetJoinLockPayload, {
      isLocked: true,
    });
    expect(lockOn.errorCount).toBe(0);
    const lockRefused = await validateBody(QuizshowSetJoinLockPayload, {
      isLocked: 'yes',
    });
    expect(lockRefused.errorProperties).toEqual(['isLocked']);
    const autoOff = await validateBody(QuizshowSetAutoAdvancePayload, {
      isOn: false,
    });
    expect(autoOff.errorCount).toBe(0);
    const autoRefused = await validateBody(QuizshowSetAutoAdvancePayload, {
      isOn: 1,
    });
    expect(autoRefused.errorProperties).toEqual(['isOn']);
  });

  it('accepts an attach with or without a device ticket and refuses a non-string or oversized ticket', async () => {
    const body = { sessionId: sampleUuid, as: 'screen' };
    for (const extra of [{}, { deviceTicket: 'header.claims.signature' }]) {
      const accepted = await validateBody(QuizshowAttachPayload, {
        ...body,
        ...extra,
      });
      expect(accepted.errorCount).toBe(0);
    }
    for (const deviceTicket of [42, 'x'.repeat(2049)]) {
      const refused = await validateBody(QuizshowAttachPayload, {
        ...body,
        deviceTicket,
      });
      expect(refused.errorProperties).toEqual(['deviceTicket']);
    }
  });
});
