import { currentHostAnswerOption } from './go-together-answers';
import { HostQuestion } from './go-together-questionnaire.catalog';
import { MatchCandidate, STRONG_FIT } from './go-together-scoring';

/**
 * The band and the "why you were grouped" lines a group sees. Reasons draw
 * only on interests, music, the calm-to-dancing energy slider, area and host
 * questions. Values, humour picks, dealbreakers and the lens never appear
 * here, because members did not agree to have those shown to strangers.
 */
export type GroupBand = 'strong' | 'good';

export type GroupReason =
  | { kind: 'interests'; tagIds: string[]; count: number; total: number }
  | { kind: 'music'; tagIds: string[]; count: number; total: number }
  | { kind: 'energy'; level: 'calm' | 'balanced' | 'lively' }
  | { kind: 'area'; areaId: string; count: number; total: number }
  | {
      kind: 'hostQuestion';
      questionId: string;
      optionId: string;
      prompt: string;
      optionLabel: string;
    };

export const MAX_REASONS = 3;

export function groupBand(minimumAffinity: number): GroupBand {
  return minimumAffinity >= STRONG_FIT ? 'strong' : 'good';
}

/** Tags held by at least two members, best first: more members, then rarer. */
function topSharedTags(
  tagLists: readonly (readonly string[])[],
  weightOf: (tagId: string) => number,
): { tagIds: string[]; count: number } | null {
  const counts = new Map<string, number>();
  for (const tags of tagLists) {
    for (const tagId of new Set(tags))
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
  }
  const ranked = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      ([firstTag, firstCount], [secondTag, secondCount]) =>
        secondCount - firstCount ||
        weightOf(secondTag) - weightOf(firstTag) ||
        firstTag.localeCompare(secondTag),
    );
  const best = ranked[0];
  if (!best) return null;
  const sameCount = ranked.filter(([, count]) => count === best[1]).slice(0, 2);
  return { tagIds: sameCount.map(([tagId]) => tagId), count: best[1] };
}

export function buildGroupReasons(
  members: readonly MatchCandidate[],
  interestIdf: ReadonlyMap<string, number>,
  hostQuestions: readonly HostQuestion[],
): GroupReason[] {
  const total = members.length;
  const reasons: GroupReason[] = [];

  const interests = topSharedTags(
    members.map((member) => member.answers.interests),
    (tagId) => interestIdf.get(tagId) ?? 1,
  );
  if (interests) reasons.push({ kind: 'interests', ...interests, total });

  const music = topSharedTags(
    members.map((member) => member.answers.music),
    () => 1,
  );
  if (music) reasons.push({ kind: 'music', ...music, total });

  const nightShapes = members.map((member) => member.answers.energy.nightShape);
  if (
    nightShapes.length > 0 &&
    Math.max(...nightShapes) - Math.min(...nightShapes) < 1.5
  ) {
    const average =
      nightShapes.reduce((sum, value) => sum + value, 0) / nightShapes.length;
    reasons.push({
      kind: 'energy',
      level: average <= 2.33 ? 'calm' : average >= 3.67 ? 'lively' : 'balanced',
    });
  }

  const areaCounts = new Map<string, number>();
  for (const member of members) {
    const area = member.answers.area;
    if (area !== null && area !== 'elsewhere')
      areaCounts.set(area, (areaCounts.get(area) ?? 0) + 1);
  }
  const topArea = [...areaCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort(
      ([firstArea, firstCount], [secondArea, secondCount]) =>
        secondCount - firstCount || firstArea.localeCompare(secondArea),
    )[0];
  if (topArea)
    reasons.push({
      kind: 'area',
      areaId: topArea[0],
      count: topArea[1],
      total,
    });

  // Each answer is read against the current question, so an option the
  // host has since removed never becomes "you all picked" copy.
  for (const question of hostQuestions) {
    const picks = members.map((member) =>
      currentHostAnswerOption(question, member.hostAnswers),
    );
    const option = picks[0];
    const isUnanimous =
      option !== undefined && picks.every((pick) => pick?.id === option.id);
    if (isUnanimous) {
      reasons.push({
        kind: 'hostQuestion',
        questionId: question.id,
        optionId: option.id,
        prompt: question.prompt,
        optionLabel: option.label,
      });
      break;
    }
  }

  return reasons.slice(0, MAX_REASONS);
}
