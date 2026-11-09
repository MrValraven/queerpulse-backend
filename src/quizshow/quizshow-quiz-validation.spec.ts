import {
  completenessProblems,
  hasAdultsRound,
  isPartyRoundKind,
  structuralProblems,
  usedLanguages,
  type QuizshowValidatableQuiz,
} from './quizshow-quiz-validation';
import {
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
  type QuizshowOption,
  type QuizshowQuestionInput,
  type QuizshowRoundInput,
  type QuizshowRoundKind,
  type QuizshowText,
} from './quizshow.contract';

type ShapeRound = QuizshowValidatableQuiz['rounds'][number];

const filledText = (label: string): QuizshowText => ({
  en: `${label} en`,
  pt: `${label} pt`,
});

const defaultSettings: QuizshowRoundInput['settings'] = {
  timeLimitSeconds: 20,
  isSpeedBonusOn: true,
  isJokerAllowed: true,
  writeSeconds: 60,
  voteSeconds: 30,
  ...QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
};

function optionsOf(count: number): QuizshowOption[] {
  return Array.from({ length: count }, (_unused, optionIndex) => ({
    id: `o${optionIndex + 1}`,
    text: filledText(`Option ${optionIndex + 1}`),
  }));
}

function multipleChoice(
  overrides: Record<string, unknown> = {},
): QuizshowQuestionInput {
  return {
    type: 'multiple_choice',
    prompt: filledText('Prompt'),
    mediaRef: null,
    timeLimitSeconds: null,
    points: 1000,
    options: optionsOf(3),
    answer: { correctIndex: 1 },
    acceptedAnswers: [],
    ...overrides,
  };
}

function questionOfType(
  type: QuizshowQuestionInput['type'],
  overrides: Record<string, unknown> = {},
): QuizshowQuestionInput {
  const byType: Record<string, Record<string, unknown>> = {
    true_false: { options: [], answer: { isTrue: true } },
    type_answer: {
      options: [],
      answer: { text: filledText('Answer') },
      acceptedAnswers: [],
    },
    order: {
      options: optionsOf(3),
      answer: { orderedIds: ['o1', 'o2', 'o3'] },
    },
    closest_number: { options: [], answer: { value: 42 } },
    prompt: { options: [], answer: null, timeLimitSeconds: null },
  };
  return {
    ...multipleChoice(),
    ...byType[type],
    type,
    ...overrides,
  } as QuizshowQuestionInput;
}

function roundOf(
  kind: QuizshowRoundKind,
  questions: QuizshowQuestionInput[],
  overrides: Partial<ShapeRound> = {},
): ShapeRound {
  return {
    kind,
    title: filledText('Round'),
    contentLabel: 'none',
    settings: defaultSettings,
    questions,
    ...overrides,
  };
}

function quizOf(
  rounds: ShapeRound[],
  overrides: Partial<QuizshowValidatableQuiz> = {},
): QuizshowValidatableQuiz {
  return { title: 'Quiz', languages: 'both', rounds, ...overrides };
}

function quizRound(questions: QuizshowQuestionInput[]): ShapeRound {
  return roundOf('quiz', questions);
}

function wheelRow(
  settings: Partial<QuizshowRoundInput['settings']> = {},
): ShapeRound {
  return {
    kind: 'wheel',
    title: { en: '', pt: '' },
    contentLabel: 'none',
    settings: { ...defaultSettings, ...settings },
    questions: [],
  };
}

function problemOf(
  code: string,
  roundIndex: number | null,
  questionIndex: number | null = null,
) {
  return { code, roundIndex, questionIndex, language: null };
}

describe('quiz validation', () => {
  it('flags too many rounds', () => {
    const rounds = Array.from({ length: 11 }, () =>
      quizRound([multipleChoice()]),
    );
    expect(structuralProblems(quizOf(rounds))).toEqual([
      {
        code: 'too_many_rounds',
        roundIndex: null,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags too many questions in the quiz', () => {
    const rounds = Array.from({ length: 6 }, () =>
      quizRound(Array.from({ length: 9 }, () => multipleChoice())),
    );
    expect(structuralProblems(quizOf(rounds))).toEqual([
      {
        code: 'too_many_questions',
        roundIndex: null,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags too many questions in one round', () => {
    const round = quizRound(Array.from({ length: 21 }, () => multipleChoice()));
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'too_many_questions_in_round',
        roundIndex: 0,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags a prompt question inside a quiz round as a type the round does not allow', () => {
    const round = quizRound([multipleChoice(), questionOfType('prompt')]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'question_type_not_allowed',
        roundIndex: 0,
        questionIndex: 1,
        language: null,
      },
    ]);
  });

  it('flags a true or false question inside a party round as a type the round does not allow', () => {
    const round = roundOf('drag_name', [
      questionOfType('prompt'),
      questionOfType('true_false'),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'question_type_not_allowed',
        roundIndex: 0,
        questionIndex: 1,
        language: null,
      },
    ]);
  });

  it('flags a wrong option count', () => {
    const round = quizRound([
      multipleChoice(),
      multipleChoice({ options: optionsOf(5), answer: { correctIndex: 0 } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      { code: 'option_count', roundIndex: 0, questionIndex: 1, language: null },
    ]);
  });

  it('flags options on a type that takes none', () => {
    const round = quizRound([
      questionOfType('true_false', { options: optionsOf(2) }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      { code: 'option_count', roundIndex: 0, questionIndex: 0, language: null },
    ]);
  });

  it('flags an order question with too few items', () => {
    const round = quizRound([
      questionOfType('order', {
        options: optionsOf(2),
        answer: { orderedIds: ['o1', 'o2'] },
      }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      { code: 'option_count', roundIndex: 0, questionIndex: 0, language: null },
    ]);
  });

  it('flags duplicate option ids', () => {
    const duplicated = optionsOf(3);
    duplicated[2] = { id: 'o1', text: filledText('Option 3') };
    const round = quizRound([multipleChoice({ options: duplicated })]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'option_ids_not_unique',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a malformed option id', () => {
    const malformed = optionsOf(3);
    malformed[0] = { id: 'Not Valid!', text: filledText('Option 1') };
    const round = quizRound([multipleChoice({ options: malformed })]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'option_ids_not_unique',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a correct index outside the options', () => {
    const round = quizRound([multipleChoice({ answer: { correctIndex: 3 } })]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_out_of_range',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a non-integer correct index', () => {
    const round = quizRound([
      multipleChoice({ answer: { correctIndex: 1.5 } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_out_of_range',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a closest number value beyond the absolute maximum', () => {
    const round = quizRound([
      questionOfType('closest_number', { answer: { value: 1e13 } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_out_of_range',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a closest number value that is not finite', () => {
    const round = quizRound([
      questionOfType('closest_number', { answer: { value: Number.NaN } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_out_of_range',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags an order answer that is not a permutation of the option ids', () => {
    const round = quizRound([
      questionOfType('order', { answer: { orderedIds: ['o1', 'o2', 'o9'] } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'order_answer_not_permutation',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a truth on a round that is not Lie Detector', () => {
    const round = roundOf('drag_name', [
      questionOfType('prompt', { answer: { truth: filledText('Truth') } }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_not_allowed',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags accepted answers on a question that is not type answer', () => {
    const round = quizRound([multipleChoice({ acceptedAnswers: ['extra'] })]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_not_allowed',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a time limit on a prompt question', () => {
    const round = roundOf('lie_detector', [
      questionOfType('prompt', {
        answer: { truth: filledText('Truth') },
        timeLimitSeconds: 30,
      }),
    ]);
    expect(structuralProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_not_allowed',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a quiz without rounds', () => {
    expect(completenessProblems(quizOf([]))).toEqual([
      {
        code: 'no_rounds',
        roundIndex: null,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags a blank title', () => {
    expect(
      completenessProblems(
        quizOf([quizRound([multipleChoice()])], { title: '   ' }),
      ),
    ).toEqual([
      {
        code: 'title_missing',
        roundIndex: null,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags a round with no questions', () => {
    expect(completenessProblems(quizOf([quizRound([])]))).toEqual([
      {
        code: 'round_empty',
        roundIndex: 0,
        questionIndex: null,
        language: null,
      },
    ]);
  });

  it('flags a blank prompt in a used language', () => {
    const round = quizRound([
      multipleChoice({ prompt: { en: 'Filled', pt: '  ' } }),
    ]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'prompt_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: 'pt',
      },
    ]);
  });

  it('flags a blank option text in a used language', () => {
    const options = optionsOf(3);
    options[1] = { id: 'o2', text: { en: '', pt: 'Opcao' } };
    const round = quizRound([multipleChoice({ options })]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'option_text_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: 'en',
      },
    ]);
  });

  it('flags a null answer on a quiz type', () => {
    const round = quizRound([multipleChoice({ answer: null })]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('flags a blank type answer text in a used language', () => {
    const round = quizRound([
      questionOfType('type_answer', {
        answer: { text: { en: 'Yes', pt: '' } },
      }),
    ]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'answer_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: 'pt',
      },
    ]);
  });

  it('flags a Lie Detector question with no truth in a used language', () => {
    const round = roundOf('lie_detector', [
      questionOfType('prompt', { answer: { truth: { en: 'Truth', pt: ' ' } } }),
    ]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'truth_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: 'pt',
      },
    ]);
  });

  it('flags a Caption This question without media', () => {
    const round = roundOf('caption_this', [
      questionOfType('prompt', { prompt: { en: '', pt: '' }, mediaRef: null }),
    ]);
    expect(completenessProblems(quizOf([round]))).toEqual([
      {
        code: 'media_missing',
        roundIndex: 0,
        questionIndex: 0,
        language: null,
      },
    ]);
  });

  it('orders problems by round, then question, then rule, then language', () => {
    const blankPrompt = { en: '', pt: '' };
    const rounds = [
      quizRound([
        multipleChoice({ prompt: blankPrompt, answer: null }),
        multipleChoice({ prompt: blankPrompt }),
      ]),
      quizRound([multipleChoice({ prompt: blankPrompt })]),
    ];
    expect(
      completenessProblems(quizOf(rounds)).map((found) => [
        found.roundIndex,
        found.questionIndex,
        found.code,
        found.language,
      ]),
    ).toEqual([
      [0, 0, 'prompt_missing', 'en'],
      [0, 0, 'prompt_missing', 'pt'],
      [0, 0, 'answer_missing', null],
      [0, 1, 'prompt_missing', 'en'],
      [0, 1, 'prompt_missing', 'pt'],
      [1, 0, 'prompt_missing', 'en'],
      [1, 0, 'prompt_missing', 'pt'],
    ]);
  });

  it('accepts a draft with blank text and null answers at save', () => {
    const blankPrompt = { en: '', pt: '' };
    const draft = quizOf(
      [
        quizRound([multipleChoice({ prompt: blankPrompt, answer: null })]),
        roundOf('lie_detector', [
          questionOfType('prompt', { prompt: blankPrompt }),
        ]),
      ],
      { title: '' },
    );
    expect(structuralProblems(draft)).toEqual([]);
    const codes = completenessProblems(draft).map((found) => found.code);
    expect(codes).toContain('prompt_missing');
    expect(codes).toContain('answer_missing');
  });

  it('exempts Caption This prompts and checks only used languages', () => {
    const portugueseOnly = quizOf(
      [
        quizRound([multipleChoice({ prompt: { en: '', pt: 'Pergunta' } })]),
        roundOf('caption_this', [
          questionOfType('prompt', {
            prompt: { en: '', pt: '' },
            mediaRef: 'event-cover/abc',
          }),
        ]),
      ],
      { languages: 'pt' },
    );
    expect(completenessProblems(portugueseOnly)).toEqual([]);
  });

  it('finds an adults round', () => {
    const plain = quizOf([quizRound([multipleChoice()])]);
    const withAdults = quizOf([
      quizRound([multipleChoice()]),
      roundOf('quiz', [multipleChoice()], { contentLabel: 'adults' }),
    ]);
    expect(hasAdultsRound(plain)).toBe(false);
    expect(hasAdultsRound(withAdults)).toBe(true);
  });

  it('does not refuse a wheel row that carries the adults label', () => {
    const labelledWheel: ShapeRound = {
      ...wheelRow(),
      contentLabel: 'adults',
    };
    const quiz = quizOf([
      labelledWheel,
      quizRound([multipleChoice()]),
      quizRound([multipleChoice()]),
    ]);
    expect(hasAdultsRound(quiz)).toBe(false);
  });

  it('keeps the 18+ checks reading content labels', () => {
    const quiz = quizOf([
      wheelRow(),
      roundOf('quiz', [multipleChoice()], { contentLabel: 'adults' }),
      quizRound([multipleChoice()]),
    ]);
    expect(hasAdultsRound(quiz)).toBe(true);
    const plain = quizOf([wheelRow(), quizRound([multipleChoice()])]);
    expect(hasAdultsRound(plain)).toBe(false);
  });

  describe('wheel rows', () => {
    it('counts too many rounds without the wheels', () => {
      const tenWithWheels = [
        wheelRow(),
        ...Array.from({ length: 4 }, () => quizRound([multipleChoice()])),
        wheelRow(),
        ...Array.from({ length: 4 }, () => quizRound([multipleChoice()])),
        wheelRow(),
        ...Array.from({ length: 2 }, () => quizRound([multipleChoice()])),
      ];
      const codes = structuralProblems(quizOf(tenWithWheels)).map(
        (found) => found.code,
      );
      expect(codes).not.toContain('too_many_rounds');
      const eleven = Array.from({ length: 11 }, () =>
        quizRound([multipleChoice()]),
      );
      expect(structuralProblems(quizOf(eleven))).toEqual([
        problemOf('too_many_rounds', null),
      ]);
    });

    it('refuses a fourth wheel', () => {
      const quizRows = [quizRound([multipleChoice()])];
      const fourWheels = quizOf([
        wheelRow(),
        wheelRow(),
        wheelRow(),
        wheelRow(),
        ...quizRows,
      ]);
      expect(structuralProblems(fourWheels)).toEqual([
        problemOf('too_many_wheels', null),
      ]);
      const threeWheels = quizOf([
        wheelRow(),
        wheelRow(),
        wheelRow(),
        ...quizRows,
      ]);
      expect(structuralProblems(threeWheels)).toEqual([]);
    });

    it('refuses every question on a wheel row with one problem each, and checks nothing else on them', () => {
      const brokenChoice = multipleChoice({
        prompt: { en: '', pt: '' },
        options: optionsOf(1).map((option) => ({
          ...option,
          text: { en: '', pt: '' },
        })),
      });
      const unanswered = questionOfType('type_answer', { answer: null });
      const wheel: ShapeRound = {
        ...wheelRow(),
        questions: [brokenChoice, unanswered],
      };
      const quiz = quizOf([
        quizRound([multipleChoice()]),
        wheel,
        quizRound([multipleChoice()]),
        quizRound([multipleChoice()]),
      ]);
      const onWheel = structuralProblems(quiz).filter(
        (found) => found.roundIndex === 1,
      );
      expect(onWheel).toEqual([
        problemOf('question_type_not_allowed', 1, 0),
        problemOf('question_type_not_allowed', 1, 1),
      ]);
      const completenessOnWheelQuestions = completenessProblems(quiz).filter(
        (found) => found.roundIndex === 1 && found.questionIndex !== null,
      );
      expect(completenessOnWheelQuestions).toEqual([]);
    });

    it('still counts wheel row questions in the question limits', () => {
      const wheel: ShapeRound = {
        ...wheelRow(),
        questions: Array.from({ length: 21 }, () => multipleChoice()),
      };
      const codes = structuralProblems(quizOf([wheel])).map(
        (found) => found.code,
      );
      expect(codes).toContain('too_many_questions_in_round');
    });

    it('counts no rounds without the wheels', () => {
      const codes = completenessProblems(quizOf([wheelRow()])).map(
        (found) => found.code,
      );
      expect(codes).toContain('no_rounds');
    });

    it('skips wheel rows in round_empty', () => {
      const quiz = quizOf([
        wheelRow(),
        quizRound([multipleChoice()]),
        quizRound([multipleChoice()]),
      ]);
      expect(
        completenessProblems(quiz).filter(
          (found) => found.code === 'round_empty',
        ),
      ).toEqual([]);
    });

    it('needs 2 rounds after each wheel', () => {
      const tooFew = (rounds: ShapeRound[]) =>
        completenessProblems(quizOf(rounds)).filter(
          (found) => found.code === 'wheel_too_few_slices',
        );
      const quizOne = () => quizRound([multipleChoice()]);
      expect(tooFew([quizOne(), wheelRow()])).toEqual([
        problemOf('wheel_too_few_slices', 1),
      ]);
      expect(tooFew([wheelRow(), wheelRow(), quizOne(), quizOne()])).toEqual([
        problemOf('wheel_too_few_slices', 0),
      ]);
      expect(
        tooFew([
          wheelRow({ sliceCount: 3 }),
          quizOne(),
          wheelRow(),
          quizOne(),
          quizOne(),
        ]),
      ).toEqual([problemOf('wheel_too_few_slices', 0)]);
      expect(tooFew([wheelRow(), quizOne(), quizOne()])).toEqual([]);
    });

    it('lists problems in row order, wheel problems in place', () => {
      const quiz = quizOf([
        roundOf('quiz', []),
        wheelRow(),
        roundOf('quiz', []),
      ]);
      expect(
        completenessProblems(quiz).map((found) => [
          found.code,
          found.roundIndex,
        ]),
      ).toEqual([
        ['round_empty', 0],
        ['wheel_too_few_slices', 1],
        ['round_empty', 2],
      ]);
    });
  });

  it('maps a language mode to the languages it uses', () => {
    expect(usedLanguages('en')).toEqual(['en']);
    expect(usedLanguages('pt')).toEqual(['pt']);
    expect(usedLanguages('both')).toEqual(['en', 'pt']);
  });

  it('tells party round kinds from the quiz kind', () => {
    expect(isPartyRoundKind('quiz')).toBe(false);
    expect(isPartyRoundKind('lie_detector')).toBe(true);
    expect(isPartyRoundKind('caption_this')).toBe(true);
    expect(isPartyRoundKind('drag_name')).toBe(true);
  });
});
