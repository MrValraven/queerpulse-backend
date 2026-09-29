import {
  AGE_BRACKETS,
  FriendMatchAnswers,
  HostAnswers,
  Lens,
  MEET_FREQUENCIES,
  VALUE_ITEM_IDS,
  ENERGY_ITEM_IDS,
} from './go-together-questionnaire.catalog';

/**
 * Go together compatibility, pure and deterministic. No I/O: the pool service
 * loads everything and passes it in. Identity never reaches this file; the
 * lens is a filter only, compared for equality and never scored.
 *
 * Weights start from the research summary in the design spec (section 5.2)
 * and change only through the offline tuning script, which bumps
 * `SCORING_VERSION` so every stored group records which weights formed it.
 */
export const SCORING_VERSION = 1;

export const GO_TOGETHER_WEIGHTS = {
  values: 0.25,
  interests: 0.2,
  energyIntent: 0.2,
  humour: 0.15,
  music: 0.1,
  ageArea: 0.1,
} as const;
export type ScoredComponent = keyof typeof GO_TOGETHER_WEIGHTS;

export const HOST_ANSWER_BONUS = 0.05;
export const STRONG_FIT = 0.62;
export const MIN_AFFINITY = 0.35;

export interface MatchCandidate {
  userId: string;
  answers: FriendMatchAnswers;
  hostAnswers: HostAnswers;
  lens: Lens | null;
}

export interface PairContext {
  /** Interest tag id -> inverse document frequency across all profiles. */
  interestIdf: ReadonlyMap<string, number>;
  /** `pairKey` of every pair with a block in either direction. */
  blockedPairs: ReadonlySet<string>;
  /** `pairKey` of every pair with a "Not for me" in either direction. */
  avoidedPairs: ReadonlySet<string>;
  /** `pairKey` of every pair that already holds an accepted connection. */
  connectedPairs: ReadonlySet<string>;
}

export type ComponentScores = Record<ScoredComponent, number> & {
  hostBonus: number;
};

export interface PairScore {
  score: number;
  components: ComponentScores;
}

export function pairKey(firstUserId: string, secondUserId: string): string {
  return firstUserId < secondUserId
    ? `${firstUserId}:${secondUserId}`
    : `${secondUserId}:${firstUserId}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function mean(numbers: readonly number[]): number {
  return numbers.length === 0
    ? 0
    : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function bracketDistance(
  first: FriendMatchAnswers,
  second: FriendMatchAnswers,
): number {
  return Math.abs(
    AGE_BRACKETS.indexOf(first.ageBracket) -
      AGE_BRACKETS.indexOf(second.ageBracket),
  );
}

/** Hard filters (spec 5.1). Blocks and avoidances come from the context;
 *  everything else is read from the two members' own answers. */
export function isPairFeasible(
  first: MatchCandidate,
  second: MatchCandidate,
  context: PairContext,
): boolean {
  const key = pairKey(first.userId, second.userId);
  if (context.blockedPairs.has(key) || context.avoidedPairs.has(key))
    return false;
  if (first.lens !== second.lens) return false;
  const hasSharedLanguage = first.answers.languages.some((language) =>
    second.answers.languages.includes(language),
  );
  if (!hasSharedLanguage) return false;
  const hasDrinkingClash =
    (first.answers.drinking === 'soberGroup' &&
      second.answers.drinking === 'willDrink') ||
    (first.answers.drinking === 'willDrink' &&
      second.answers.drinking === 'soberGroup');
  if (hasDrinkingClash) return false;
  const isSimilarAgeWanted =
    first.answers.agePreference === 'similar' ||
    second.answers.agePreference === 'similar';
  if (isSimilarAgeWanted && bracketDistance(first.answers, second.answers) > 1)
    return false;
  return true;
}

/** Values are ipsatised (each answer minus the person's own mean) so a
 *  generous rater and a harsh rater with the same priorities compare equal. */
function valuesSimilarity(
  first: FriendMatchAnswers,
  second: FriendMatchAnswers,
): number {
  const firstMean = mean(VALUE_ITEM_IDS.map((itemId) => first.values[itemId]));
  const secondMean = mean(
    VALUE_ITEM_IDS.map((itemId) => second.values[itemId]),
  );
  const differences = VALUE_ITEM_IDS.map((itemId) =>
    Math.abs(
      first.values[itemId] - firstMean - (second.values[itemId] - secondMean),
    ),
  );
  return clamp01(1 - mean(differences) / 4);
}

/** Jaccard where a rare shared tag counts more than a common one. */
function weightedJaccard(
  first: readonly string[],
  second: readonly string[],
  weightOf: (tagId: string) => number,
): number {
  const union = new Set([...first, ...second]);
  if (union.size === 0) return 0.5;
  const secondSet = new Set(second);
  let shared = 0;
  let total = 0;
  for (const tagId of union) {
    const weight = weightOf(tagId);
    total += weight;
    if (secondSet.has(tagId) && first.includes(tagId)) shared += weight;
  }
  return total === 0 ? 0.5 : shared / total;
}

function energyIntentSimilarity(
  first: FriendMatchAnswers,
  second: FriendMatchAnswers,
): number {
  const energy =
    1 -
    mean(
      ENERGY_ITEM_IDS.map((itemId) =>
        Math.abs(first.energy[itemId] - second.energy[itemId]),
      ),
    ) /
      4;
  const intentPart =
    first.intent === second.intent
      ? 1
      : first.intent === 'both' || second.intent === 'both'
        ? 0.5
        : 0;
  const frequencyPart =
    1 -
    Math.abs(
      MEET_FREQUENCIES.indexOf(first.meetFrequency) -
        MEET_FREQUENCIES.indexOf(second.meetFrequency),
    ) /
      2;
  return clamp01(
    0.75 * energy + 0.25 * (0.5 * intentPart + 0.5 * frequencyPart),
  );
}

function humourSimilarity(
  first: FriendMatchAnswers,
  second: FriendMatchAnswers,
): number {
  const shared = Object.keys(first.humour).filter(
    (pairId) =>
      second.humour[pairId as keyof FriendMatchAnswers['humour']] !== undefined,
  ) as (keyof FriendMatchAnswers['humour'])[];
  if (shared.length === 0) return 0.5;
  return (
    shared.filter((pairId) => first.humour[pairId] === second.humour[pairId])
      .length / shared.length
  );
}

function ageAreaSimilarity(
  first: FriendMatchAnswers,
  second: FriendMatchAnswers,
): number {
  const age = 1 - bracketDistance(first, second) / 4;
  let area = 0.5;
  if (first.area !== null && second.area !== null) {
    area = first.area === second.area && first.area !== 'elsewhere' ? 1 : 0;
  }
  return clamp01(0.5 * age + 0.5 * area);
}

function sharedHostAnswers(first: HostAnswers, second: HostAnswers): number {
  return Object.keys(first).filter(
    (questionId) => first[questionId] === second[questionId],
  ).length;
}

export function scorePair(
  first: MatchCandidate,
  second: MatchCandidate,
  context: PairContext,
): PairScore {
  const idfOf = (tagId: string): number => context.interestIdf.get(tagId) ?? 1;
  const components: ComponentScores = {
    values: valuesSimilarity(first.answers, second.answers),
    interests: weightedJaccard(
      first.answers.interests,
      second.answers.interests,
      idfOf,
    ),
    energyIntent: energyIntentSimilarity(first.answers, second.answers),
    humour: humourSimilarity(first.answers, second.answers),
    music:
      first.answers.music.length === 0 || second.answers.music.length === 0
        ? 0.5
        : weightedJaccard(first.answers.music, second.answers.music, () => 1),
    ageArea: ageAreaSimilarity(first.answers, second.answers),
    hostBonus:
      HOST_ANSWER_BONUS *
      sharedHostAnswers(first.hostAnswers, second.hostAnswers),
  };
  const weighted = (
    Object.keys(GO_TOGETHER_WEIGHTS) as ScoredComponent[]
  ).reduce(
    (sum, component) =>
      sum + GO_TOGETHER_WEIGHTS[component] * components[component],
    0,
  );
  return { score: clamp01(weighted + components.hostBonus), components };
}

/** Smoothed IDF over every current questionnaire profile on the platform:
 *  ln((N + 1) / (df + 1)) + 1, where N counts the profiles and df the
 *  profiles holding the tag. The pool service gets both from one aggregate
 *  query (a count per tag plus the profile total) and never loads anyone's
 *  interest list, so this takes the counts. */
export function interestIdfFromFrequencies(
  documentFrequency: ReadonlyMap<string, number>,
  profileTotal: number,
): Map<string, number> {
  const idf = new Map<string, number>();
  for (const [tagId, frequency] of documentFrequency) {
    idf.set(tagId, Math.log((profileTotal + 1) / (frequency + 1)) + 1);
  }
  return idf;
}

/** The same IDF from plain interest lists, one per profile. Kept for tests
 *  and tools that already hold the lists. */
export function computeInterestIdf(
  interestLists: readonly (readonly string[])[],
): Map<string, number> {
  const documentFrequency = new Map<string, number>();
  for (const interests of interestLists) {
    for (const tagId of new Set(interests)) {
      documentFrequency.set(tagId, (documentFrequency.get(tagId) ?? 0) + 1);
    }
  }
  return interestIdfFromFrequencies(documentFrequency, interestLists.length);
}
