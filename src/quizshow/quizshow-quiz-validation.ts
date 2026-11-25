import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_PARTY_ROUND_KINDS,
  type QuizshowClosestTolerance,
  type QuizshowLanguage,
  type QuizshowLanguageMode,
  type QuizshowOption,
  type QuizshowQuestionInput,
  type QuizshowQuizProblem,
  type QuizshowQuizProblemCode,
  type QuizshowRoundInput,
  type QuizshowRoundKind,
} from './quizshow.contract';
import {
  isInWheelRange,
  isWheelRoundKind,
  playableRoundCount,
  wheelSliceRoundIndexes,
} from './quizshow-wheel';

/** An input, a stored quiz, a template and a seed all fit this shape. */
export type QuizshowValidatableQuiz = {
  title: string;
  languages: QuizshowLanguageMode;
  rounds: ReadonlyArray<
    Omit<QuizshowRoundInput, 'questions'> & {
      questions: readonly QuizshowQuestionInput[];
    }
  >;
};

export function usedLanguages(mode: QuizshowLanguageMode): QuizshowLanguage[] {
  if (mode === 'both') {
    return ['en', 'pt'];
  }
  return [mode];
}

export function isPartyRoundKind(kind: QuizshowRoundKind): boolean {
  return (QUIZSHOW_PARTY_ROUND_KINDS as readonly string[]).includes(kind);
}

export function hasAdultsRound(
  quiz: Pick<QuizshowValidatableQuiz, 'rounds'>,
): boolean {
  // A wheel row carries no content: a label sent on one is cleared on save, so
  // it must not refuse a session before that happens.
  return quiz.rounds.some(
    (round) => !isWheelRoundKind(round.kind) && round.contentLabel === 'adults',
  );
}

function problem(
  code: QuizshowQuizProblemCode,
  roundIndex: number | null,
  questionIndex: number | null,
  language: QuizshowLanguage | null = null,
): QuizshowQuizProblem {
  return { code, roundIndex, questionIndex, language };
}

function isBlank(text: string | null | undefined): boolean {
  return typeof text !== 'string' || text.trim().length === 0;
}

function isOptionCountValid(question: QuizshowQuestionInput): boolean {
  const optionCount = question.options.length;
  // A poll takes the multiple choice option rules (contract 6.22).
  if (question.type === 'multiple_choice' || question.type === 'poll') {
    return (
      optionCount >= QUIZSHOW_LIMITS.multipleChoiceOptionsMin &&
      optionCount <= QUIZSHOW_LIMITS.multipleChoiceOptionsMax
    );
  }
  if (question.type === 'order') {
    return (
      optionCount >= QUIZSHOW_LIMITS.orderItemsMin &&
      optionCount <= QUIZSHOW_LIMITS.orderItemsMax
    );
  }
  return optionCount === 0;
}

function hasUniqueWellFormedOptionIds(
  options: readonly QuizshowOption[],
): boolean {
  const seenIds = new Set<string>();
  for (const option of options) {
    if (
      typeof option.id !== 'string' ||
      !QUIZSHOW_LIMITS.optionIdPattern.test(option.id) ||
      seenIds.has(option.id)
    ) {
      return false;
    }
    seenIds.add(option.id);
  }
  return true;
}

function isAnswerInRange(question: QuizshowQuestionInput): boolean {
  if (question.type === 'multiple_choice' && question.answer !== null) {
    // An index outside the options or a repeated one has no code of its own
    // (decision A21), so it stays this answer problem.
    const { correctIndexes } = question.answer;
    if (!Array.isArray(correctIndexes)) {
      return false;
    }
    return (
      new Set(correctIndexes).size === correctIndexes.length &&
      correctIndexes.every(
        (optionIndex) =>
          Number.isInteger(optionIndex) &&
          optionIndex >= 0 &&
          optionIndex < question.options.length,
      )
    );
  }
  if (question.type === 'closest_number' && question.answer !== null) {
    const { value } = question.answer;
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Math.abs(value) <= QUIZSHOW_LIMITS.numberAbsMax
    );
  }
  return true;
}

/** At least one option stays wrong, or the question gives every answer away. */
function hasTooManyCorrectOptions(question: QuizshowQuestionInput): boolean {
  if (question.type !== 'multiple_choice' || question.answer === null) {
    return false;
  }
  const { correctIndexes } = question.answer;
  // An empty list is the completeness problem `correct_option_missing`.
  return (
    Array.isArray(correctIndexes) &&
    correctIndexes.length > 0 &&
    correctIndexes.length >= question.options.length
  );
}

/** Contract 6.1: the amount each tolerance mode allows. */
function isToleranceInRange(question: QuizshowQuestionInput): boolean {
  if (question.type !== 'closest_number' || question.answer === null) {
    return true;
  }
  const tolerance = question.answer.tolerance as
    QuizshowClosestTolerance | null | undefined;
  if (tolerance === null || typeof tolerance !== 'object') {
    return false;
  }
  const { mode, amount } = tolerance;
  switch (mode) {
    case 'exact':
      return amount === 0;
    case 'absolute':
      return (
        typeof amount === 'number' &&
        Number.isFinite(amount) &&
        amount > 0 &&
        amount <= QUIZSHOW_LIMITS.numberAbsMax
      );
    case 'percent':
      return (
        Number.isInteger(amount) &&
        amount >= QUIZSHOW_LIMITS.closestPercentMin &&
        amount <= QUIZSHOW_LIMITS.closestPercentMax
      );
    default:
      return false;
  }
}

/** Contract 6.23: a slow reveal blurs a picture in, so it needs one. */
function isSlowRevealMissingPicture(question: QuizshowQuestionInput): boolean {
  return question.mediaReveal === 'slow' && question.mediaRef === null;
}

function isOrderAnswerPermutation(question: QuizshowQuestionInput): boolean {
  if (question.type !== 'order' || question.answer === null) {
    return true;
  }
  const orderedIds = question.answer.orderedIds;
  if (orderedIds.length !== question.options.length) {
    return false;
  }
  const optionIds = new Set(question.options.map((option) => option.id));
  const orderedIdSet = new Set(orderedIds);
  return (
    orderedIdSet.size === orderedIds.length &&
    orderedIds.every((orderedId) => optionIds.has(orderedId))
  );
}

function isAnswerAllowed(
  question: QuizshowQuestionInput,
  roundKind: QuizshowRoundKind,
): boolean {
  if (question.type === 'prompt') {
    if (question.answer !== null && roundKind !== 'lie_detector') {
      return false;
    }
    if (question.timeLimitSeconds !== null) {
      return false;
    }
  }
  // A poll has no right answer to store (contract 2.4).
  if (question.type === 'poll' && question.answer !== null) {
    return false;
  }
  if (question.type !== 'type_answer' && question.acceptedAnswers.length > 0) {
    return false;
  }
  return true;
}

function questionStructuralProblems(
  question: QuizshowQuestionInput,
  roundKind: QuizshowRoundKind,
  roundIndex: number,
  questionIndex: number,
): QuizshowQuizProblem[] {
  const problems: QuizshowQuizProblem[] = [];
  const isPartyRound = isPartyRoundKind(roundKind);
  // A poll in a party round names its own problem, so the studio can say why.
  if (isPartyRound && question.type === 'poll') {
    problems.push(problem('poll_in_party_round', roundIndex, questionIndex));
  } else {
    const isTypeAllowed = isPartyRound
      ? question.type === 'prompt'
      : question.type !== 'prompt';
    if (!isTypeAllowed) {
      problems.push(
        problem('question_type_not_allowed', roundIndex, questionIndex),
      );
    }
  }
  if (!isOptionCountValid(question)) {
    problems.push(problem('option_count', roundIndex, questionIndex));
  }
  if (!hasUniqueWellFormedOptionIds(question.options)) {
    problems.push(problem('option_ids_not_unique', roundIndex, questionIndex));
  }
  if (!isAnswerInRange(question)) {
    problems.push(problem('answer_out_of_range', roundIndex, questionIndex));
  }
  if (hasTooManyCorrectOptions(question)) {
    problems.push(
      problem('too_many_correct_options', roundIndex, questionIndex),
    );
  }
  if (!isToleranceInRange(question)) {
    problems.push(problem('tolerance_out_of_range', roundIndex, questionIndex));
  }
  // Save stores 'instant' on party rows, so only a quiz round can hold 'slow'.
  if (!isPartyRound && isSlowRevealMissingPicture(question)) {
    problems.push(
      problem('slow_reveal_needs_picture', roundIndex, questionIndex),
    );
  }
  if (!isOrderAnswerPermutation(question)) {
    problems.push(
      problem('order_answer_not_permutation', roundIndex, questionIndex),
    );
  }
  if (!isAnswerAllowed(question, roundKind)) {
    problems.push(problem('answer_not_allowed', roundIndex, questionIndex));
  }
  return problems;
}

export function structuralProblems(
  quiz: QuizshowValidatableQuiz,
): QuizshowQuizProblem[] {
  const problems: QuizshowQuizProblem[] = [];
  if (playableRoundCount(quiz.rounds) > QUIZSHOW_LIMITS.roundsMax) {
    problems.push(problem('too_many_rounds', null, null));
  }
  const wheelCount = quiz.rounds.filter((round) =>
    isWheelRoundKind(round.kind),
  ).length;
  if (wheelCount > QUIZSHOW_LIMITS.wheelStepsMax) {
    problems.push(problem('too_many_wheels', null, null));
  }
  const totalQuestions = quiz.rounds.reduce(
    (runningTotal, round) => runningTotal + round.questions.length,
    0,
  );
  if (totalQuestions > QUIZSHOW_LIMITS.questionsPerQuizMax) {
    problems.push(problem('too_many_questions', null, null));
  }
  const firstPlayableRoundIndex = quiz.rounds.findIndex(
    (round) => !isWheelRoundKind(round.kind),
  );
  quiz.rounds.forEach((round, roundIndex) => {
    if (round.questions.length > QUIZSHOW_LIMITS.questionsPerRoundMax) {
      problems.push(problem('too_many_questions_in_round', roundIndex, null));
    }
    // Contract 6.19: the warm-up opens the night (decision A29). A wheel slice
    // plays only when the wheel draws it, so a warm-up on one never opens the night.
    if (
      round.settings.isWarmUp === true &&
      (roundIndex !== firstPlayableRoundIndex ||
        isInWheelRange(quiz.rounds, roundIndex))
    ) {
      problems.push(problem('warm_up_not_first', roundIndex, null));
    }
    round.questions.forEach((question, questionIndex) => {
      if (isWheelRoundKind(round.kind)) {
        // A wheel row holds no questions, so each one gets this single problem.
        problems.push(
          problem('question_type_not_allowed', roundIndex, questionIndex),
        );
        return;
      }
      problems.push(
        ...questionStructuralProblems(
          question,
          round.kind,
          roundIndex,
          questionIndex,
        ),
      );
    });
  });
  return problems;
}

function questionCompletenessProblems(
  question: QuizshowQuestionInput,
  roundKind: QuizshowRoundKind,
  languages: readonly QuizshowLanguage[],
  roundIndex: number,
  questionIndex: number,
): QuizshowQuizProblem[] {
  const problems: QuizshowQuizProblem[] = [];
  if (roundKind !== 'caption_this') {
    for (const language of languages) {
      if (isBlank(question.prompt?.[language])) {
        problems.push(
          problem('prompt_missing', roundIndex, questionIndex, language),
        );
      }
    }
  }
  for (const language of languages) {
    if (question.options.some((option) => isBlank(option.text?.[language]))) {
      problems.push(
        problem('option_text_missing', roundIndex, questionIndex, language),
      );
    }
  }
  if (question.type === 'type_answer') {
    if (question.answer === null) {
      problems.push(problem('answer_missing', roundIndex, questionIndex));
    } else {
      for (const language of languages) {
        if (isBlank(question.answer.text?.[language])) {
          problems.push(
            problem('answer_missing', roundIndex, questionIndex, language),
          );
        }
      }
    }
  } else if (
    question.type !== 'prompt' &&
    question.type !== 'poll' &&
    question.answer === null
  ) {
    problems.push(problem('answer_missing', roundIndex, questionIndex));
  }
  if (
    question.type === 'multiple_choice' &&
    question.answer !== null &&
    Array.isArray(question.answer.correctIndexes) &&
    question.answer.correctIndexes.length === 0
  ) {
    problems.push(problem('correct_option_missing', roundIndex, questionIndex));
  }
  if (roundKind === 'lie_detector' && question.type === 'prompt') {
    for (const language of languages) {
      const truthText =
        question.answer === null ? null : question.answer.truth?.[language];
      if (isBlank(truthText)) {
        problems.push(
          problem('truth_missing', roundIndex, questionIndex, language),
        );
      }
    }
  }
  if (roundKind === 'caption_this' && isBlank(question.mediaRef)) {
    problems.push(problem('media_missing', roundIndex, questionIndex));
  }
  return problems;
}

export function completenessProblems(
  quiz: QuizshowValidatableQuiz,
): QuizshowQuizProblem[] {
  const problems: QuizshowQuizProblem[] = [];
  if (playableRoundCount(quiz.rounds) === 0) {
    problems.push(problem('no_rounds', null, null));
  }
  if (isBlank(quiz.title)) {
    problems.push(problem('title_missing', null, null));
  }
  const languages = usedLanguages(quiz.languages);
  quiz.rounds.forEach((round, roundIndex) => {
    if (isWheelRoundKind(round.kind)) {
      if (
        wheelSliceRoundIndexes(quiz.rounds, roundIndex).length <
        QUIZSHOW_LIMITS.wheelSlicesMin
      ) {
        problems.push(problem('wheel_too_few_slices', roundIndex, null));
      }
      return;
    }
    if (round.questions.length === 0) {
      problems.push(problem('round_empty', roundIndex, null));
    }
    round.questions.forEach((question, questionIndex) => {
      problems.push(
        ...questionCompletenessProblems(
          question,
          round.kind,
          languages,
          roundIndex,
          questionIndex,
        ),
      );
    });
  });
  return problems;
}
