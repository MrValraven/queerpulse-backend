import { randomUUID } from 'crypto';
import { toImageUrl } from '../common/image-url';
import type { QuizshowQuestionRecord } from './entities/quizshow-question.entity';
import type { QuizshowQuizRecord } from './entities/quizshow-quiz.entity';
import type { QuizshowRoundRecord } from './entities/quizshow-round.entity';
import type { QuizshowValidatableQuiz } from './quizshow-quiz-validation';
import type {
  QuizshowQuestion,
  QuizshowQuiz,
  QuizshowQuizShape,
  QuizshowRound,
} from './quizshow.contract';

function toQuizshowQuestion(record: QuizshowQuestionRecord): QuizshowQuestion {
  return {
    id: record.id,
    type: record.type,
    prompt: { en: record.promptEn, pt: record.promptPt },
    mediaRef: record.mediaRef,
    mediaUrl: toImageUrl(record.mediaRef),
    timeLimitSeconds: record.timeLimitSeconds,
    points: record.points,
    options: record.options,
    answer: record.answer,
    acceptedAnswers: record.acceptedAnswers,
  } as QuizshowQuestion;
}

/** Rows to the wire quiz: rounds and questions in position order. */
export function toQuizshowQuiz(
  quiz: QuizshowQuizRecord,
  rounds: QuizshowRoundRecord[],
  questions: QuizshowQuestionRecord[],
): QuizshowQuiz {
  const orderedQuestions = [...questions].sort(
    (first, second) => first.position - second.position,
  );
  const mappedRounds: QuizshowRound[] = [...rounds]
    .sort((first, second) => first.position - second.position)
    .map((round) => ({
      id: round.id,
      kind: round.kind,
      title: { en: round.titleEn, pt: round.titlePt },
      contentLabel: round.contentLabel,
      settings: round.settings,
      questions: orderedQuestions
        .filter((question) => question.roundId === round.id)
        .map(toQuizshowQuestion),
    }));
  return {
    title: quiz.title,
    languages: quiz.languages,
    screenLanguage: quiz.screenLanguage,
    sourceTemplateId: quiz.sourceTemplateId,
    updatedAt: quiz.updatedAt.toISOString(),
    rounds: mappedRounds,
  };
}

/** The wire quiz without ids, urls and the stamp: the shape an input or an import copies. */
export function toQuizShape(quiz: QuizshowQuiz): QuizshowQuizShape {
  return {
    title: quiz.title,
    languages: quiz.languages,
    screenLanguage: quiz.screenLanguage,
    rounds: quiz.rounds.map((round) => ({
      kind: round.kind,
      title: round.title,
      contentLabel: round.contentLabel,
      settings: round.settings,
      questions: round.questions.map(
        ({ id: _id, mediaUrl: _mediaUrl, ...questionInput }) => questionInput,
      ),
    })),
  };
}

/** New rows with fresh uuids, so each question names its round before insert. */
export function buildRoundRows(
  quizId: string,
  rounds: QuizshowValidatableQuiz['rounds'],
): {
  rounds: Partial<QuizshowRoundRecord>[];
  questions: Partial<QuizshowQuestionRecord>[];
} {
  const roundRows: Partial<QuizshowRoundRecord>[] = [];
  const questionRows: Partial<QuizshowQuestionRecord>[] = [];
  rounds.forEach((round, roundPosition) => {
    const roundId = randomUUID();
    roundRows.push({
      id: roundId,
      quizId,
      position: roundPosition,
      kind: round.kind,
      titleEn: round.title.en,
      titlePt: round.title.pt,
      contentLabel: round.contentLabel,
      settings: round.settings,
    });
    round.questions.forEach((question, questionPosition) => {
      questionRows.push({
        id: randomUUID(),
        roundId,
        position: questionPosition,
        type: question.type,
        promptEn: question.prompt.en,
        promptPt: question.prompt.pt,
        mediaRef: question.mediaRef,
        options: question.options,
        answer: question.answer,
        acceptedAnswers: question.acceptedAnswers,
        timeLimitSeconds: question.timeLimitSeconds,
        points: question.points,
      });
    });
  });
  return { rounds: roundRows, questions: questionRows };
}
