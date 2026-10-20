/**
 * Typed answer matching for Pulse Live. The frontend demo engine copies these
 * bodies exactly, so a typed answer scores the same in demo and live.
 */
import type { QuizshowText } from './quizshow.contract';

/** Shortest space-free candidate that tolerates one typo. */
const TYPO_TOLERANT_MIN_LENGTH = 5;

/**
 * Lowercases, strips accents (NFD then every combining mark), turns every
 * character outside letters and numbers into a space, collapses spaces, trims.
 */
export function normaliseAnswerText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/ +/g, ' ')
    .trim();
}

/**
 * Optimal string alignment distance of at most 1, in one linear pass: equal
 * lengths allow one substitution or one adjacent swap, lengths one apart allow
 * one insertion, and lengths further apart never match.
 */
export function isWithinOneEdit(left: string, right: string): boolean {
  const lengthDifference = left.length - right.length;
  if (Math.abs(lengthDifference) > 1) return false;

  if (lengthDifference === 0) {
    let mismatchIndex = 0;
    while (
      mismatchIndex < left.length &&
      left[mismatchIndex] === right[mismatchIndex]
    ) {
      mismatchIndex += 1;
    }
    if (mismatchIndex === left.length) return true;
    if (left.slice(mismatchIndex + 1) === right.slice(mismatchIndex + 1))
      return true;
    const isAdjacentSwap =
      mismatchIndex + 1 < left.length &&
      left[mismatchIndex] === right[mismatchIndex + 1] &&
      left[mismatchIndex + 1] === right[mismatchIndex];
    return (
      isAdjacentSwap &&
      left.slice(mismatchIndex + 2) === right.slice(mismatchIndex + 2)
    );
  }

  const shorter = lengthDifference < 0 ? left : right;
  const longer = lengthDifference < 0 ? right : left;
  let mismatchIndex = 0;
  while (
    mismatchIndex < shorter.length &&
    shorter[mismatchIndex] === longer[mismatchIndex]
  ) {
    mismatchIndex += 1;
  }
  return shorter.slice(mismatchIndex) === longer.slice(mismatchIndex + 1);
}

/**
 * A submission matches a candidate when their normalised, space-free forms are
 * equal, or one edit apart once the candidate has five or more characters.
 * A blank submission matches nothing and blank candidates are skipped.
 */
export function isTypedAnswerMatch(
  submitted: string,
  candidates: readonly string[],
): boolean {
  const submittedKey = normaliseAnswerText(submitted).replace(/ /g, '');
  if (submittedKey === '') return false;
  return candidates.some((candidate) => {
    const candidateKey = normaliseAnswerText(candidate).replace(/ /g, '');
    if (candidateKey === '') return false;
    if (candidateKey === submittedKey) return true;
    return (
      candidateKey.length >= TYPO_TOLERANT_MIN_LENGTH &&
      isWithinOneEdit(submittedKey, candidateKey)
    );
  });
}

/** The English text, the Portuguese text and every accepted answer, blanks skipped. */
export function typedAnswerCandidates(
  answer: { text: QuizshowText },
  acceptedAnswers: readonly string[],
): string[] {
  return [answer.text.en, answer.text.pt, ...acceptedAnswers].filter(
    (candidate) => candidate.trim() !== '',
  );
}
