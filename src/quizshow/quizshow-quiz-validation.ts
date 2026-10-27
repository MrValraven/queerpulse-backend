import {
  QUIZSHOW_LIMITS,
  QUIZSHOW_PARTY_ROUND_KINDS,
  type QuizshowLanguage,
  type QuizshowLanguageMode,
  type QuizshowOption,
  type QuizshowQuestionInput,
  type QuizshowQuizProblem,
  type QuizshowQuizProblemCode,
  type QuizshowRoundInput,
  type QuizshowRoundKind,
} from './quizshow.contract';

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
  return quiz.rounds.some((round) => round.contentLabel === 'adults');
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
  if (question.type === 'multiple_choice') {
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
    const { correctIndex } = question.answer;
    return (
      Number.isInteger(correctIndex) &&
      correctIndex >= 0 &&
      correctIndex < question.options.length
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
  const isTypeAllowed = isPartyRound
    ? question.type === 'prompt'
    : question.type !== 'prompt';
  if (!isTypeAllowed) {
    problems.push(
      problem('question_type_not_allowed', roundIndex, questionIndex),
    );
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
  if (quiz.rounds.length > QUIZSHOW_LIMITS.roundsMax) {
    problems.push(problem('too_many_rounds', null, null));
  }
  const totalQuestions = quiz.rounds.reduce(
    (runningTotal, round) => runningTotal + round.questions.length,
    0,
  );
  if (totalQuestions > QUIZSHOW_LIMITS.questionsPerQuizMax) {
    problems.push(problem('too_many_questions', null, null));
  }
  quiz.rounds.forEach((round, roundIndex) => {
    if (round.questions.length > QUIZSHOW_LIMITS.questionsPerRoundMax) {
      problems.push(problem('too_many_questions_in_round', roundIndex, null));
    }
    round.questions.forEach((question, questionIndex) => {
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
  } else if (question.type !== 'prompt' && question.answer === null) {
    problems.push(problem('answer_missing', roundIndex, questionIndex));
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
  if (quiz.rounds.length === 0) {
    problems.push(problem('no_rounds', null, null));
  }
  if (isBlank(quiz.title)) {
    problems.push(problem('title_missing', null, null));
  }
  const languages = usedLanguages(quiz.languages);
  quiz.rounds.forEach((round, roundIndex) => {
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
