/**
 * Go together group formation, pure and deterministic.
 *
 * The problem: split units (a solo, an accepted pair, or a regroup anchor)
 * into groups of 4 to 5 people so that the worst-off member is as well placed
 * as possible, then the group total is as high as possible. It is a
 * size-constrained graph partition (the maximally diverse grouping problem with
 * similarity weights), NP-hard in general, so pools of up to 10 people are
 * solved exactly and larger pools by greedy seeding plus simulated annealing
 * with restarts.
 *
 * Determinism: the same graph, units and seed give the same groups. The
 * iteration count is fixed; `timeBudgetMs` is a safety cap that only cuts a
 * run short when the machine is overloaded, and the result reports it.
 */

export interface MatchGraph {
  /** Number of people in the pool. People are addressed by index. */
  size: number;
  score(first: number, second: number): number;
  feasible(first: number, second: number): boolean;
  /** Talker slider at 4 or 5. */
  isTalker(person: number): boolean;
  connected(first: number, second: number): boolean;
}

export interface MatchUnit {
  /** Stable id (the entry id of the unit's first member) for logs and ties. */
  id: string;
  /** 1 person for a solo, 2 for a pair, 2 or 3 for a regroup anchor. */
  members: number[];
}

export interface GroupingOptions {
  seed: number;
  minAffinity: number;
  restarts?: number;
  iterationsPerRestart?: number;
  timeBudgetMs?: number;
  now?: () => number;
}

export interface GroupingResult {
  /** Each group is a list of unit indexes. */
  groups: number[][];
  unmatchedUnits: number[];
  /** Affinity of every grouped person, by person index. */
  affinity: Map<number, number>;
  /** Lowest affinity per group, aligned with `groups`. */
  groupMinimumAffinity: number[];
  hitTimeBudget: boolean;
}

export const EXACT_POOL_LIMIT = 10;
export const PREFERRED_SIZES: readonly number[] = [4, 5];
export const NO_TALKER_PENALTY = 0.05;
export const CONNECTED_PAIR_PENALTY = 0.03;
const EPSILON = 1e-9;

/** Sizes for n people: 4s and 5s when possible, one 6 or one 3 otherwise. */
export function planGroupSizes(personCount: number): number[] {
  if (personCount < 3) return [];
  if (personCount === 3) return [3];
  if (personCount === 6) return [6];
  if (personCount === 7) return [4, 3];
  if (personCount === 11) return [6, 5];
  const groupCount = Math.ceil(personCount / 5);
  const base = Math.floor(personCount / groupCount);
  const remainder = personCount % groupCount;
  return Array.from({ length: groupCount }, (_, index) =>
    index < remainder ? base + 1 : base,
  );
}

export function allowedSizesFor(plan: readonly number[]): Set<number> {
  return new Set([...PREFERRED_SIZES, ...plan]);
}

/** Mulberry32: small, fast, seedable. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, used to turn an event id and run number into a seed. */
export function seedFrom(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface GroupStats {
  violations: number;
  people: number;
  minimumAffinity: number;
  sumSqrt: number;
  penalty: number;
}

interface Aggregate {
  violations: number;
  matched: number;
  minimumAffinity: number;
  total: number;
}

const EMPTY_STATS: GroupStats = {
  violations: 0,
  people: 0,
  minimumAffinity: Infinity,
  sumSqrt: 0,
  penalty: 0,
};

function personAffinities(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  unitIndexes: readonly number[],
): Map<number, number> {
  const affinities = new Map<number, number>();
  for (const unitIndex of unitIndexes) {
    for (const person of units[unitIndex]?.members ?? []) {
      let sum = 0;
      let count = 0;
      for (const otherUnitIndex of unitIndexes) {
        if (otherUnitIndex === unitIndex) continue;
        for (const other of units[otherUnitIndex]?.members ?? []) {
          sum += graph.score(person, other);
          count += 1;
        }
      }
      affinities.set(person, count === 0 ? 0 : sum / count);
    }
  }
  return affinities;
}

function evaluateGroup(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  unitIndexes: readonly number[],
  allowedSizes: ReadonlySet<number>,
): GroupStats {
  if (unitIndexes.length === 0) return EMPTY_STATS;
  const people = unitIndexes.flatMap(
    (unitIndex) => units[unitIndex]?.members ?? [],
  );
  let violations = 0;
  if (!allowedSizes.has(people.length)) violations += 1;
  if (unitIndexes.length < 2) violations += 1;
  if (
    unitIndexes.filter(
      (unitIndex) => (units[unitIndex]?.members.length ?? 0) > 1,
    ).length > 1
  )
    violations += 1;
  let penalty = 0;
  for (let firstUnit = 0; firstUnit < unitIndexes.length; firstUnit += 1) {
    for (
      let secondUnit = firstUnit + 1;
      secondUnit < unitIndexes.length;
      secondUnit += 1
    ) {
      for (const first of units[unitIndexes[firstUnit] ?? -1]?.members ?? []) {
        for (const second of units[unitIndexes[secondUnit] ?? -1]?.members ??
          []) {
          if (!graph.feasible(first, second)) violations += 1;
          if (graph.connected(first, second)) penalty += CONNECTED_PAIR_PENALTY;
        }
      }
    }
  }
  if (!people.some((person) => graph.isTalker(person)))
    penalty += NO_TALKER_PENALTY;
  const affinities = [...personAffinities(graph, units, unitIndexes).values()];
  return {
    violations,
    people: people.length,
    minimumAffinity: Math.min(...affinities),
    sumSqrt: affinities.reduce(
      (sum, affinity) => sum + Math.sqrt(Math.max(0, affinity)),
      0,
    ),
    penalty,
  };
}

function aggregate(stats: readonly GroupStats[]): Aggregate {
  let violations = 0;
  let matched = 0;
  let minimumAffinity = Infinity;
  let total = 0;
  for (const group of stats) {
    violations += group.violations;
    matched += group.people;
    if (group.people > 0)
      minimumAffinity = Math.min(minimumAffinity, group.minimumAffinity);
    total += group.sumSqrt - group.penalty;
  }
  return {
    violations,
    matched,
    minimumAffinity: minimumAffinity === Infinity ? 0 : minimumAffinity,
    total,
  };
}

/** Lexicographic: fewer violations, more people grouped, higher worst member, higher total. */
export function isBetter(candidate: Aggregate, incumbent: Aggregate): boolean {
  if (candidate.violations !== incumbent.violations)
    return candidate.violations < incumbent.violations;
  if (candidate.matched !== incumbent.matched)
    return candidate.matched > incumbent.matched;
  if (
    Math.abs(candidate.minimumAffinity - incumbent.minimumAffinity) > EPSILON
  ) {
    return candidate.minimumAffinity > incumbent.minimumAffinity;
  }
  return candidate.total > incumbent.total + EPSILON;
}

function scalar(value: Aggregate, personCount: number): number {
  return (
    -1000 * value.violations +
    10 * value.matched +
    20 * value.minimumAffinity +
    (2 * value.total) / Math.max(1, personCount)
  );
}

function canJoin(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  groupUnits: readonly number[],
  unitIndex: number,
  maxSize: number,
): boolean {
  const unit = units[unitIndex];
  if (!unit) return false;
  const people = groupUnits.reduce(
    (sum, member) => sum + (units[member]?.members.length ?? 0),
    0,
  );
  if (people + unit.members.length > maxSize) return false;
  if (
    unit.members.length > 1 &&
    groupUnits.some((member) => (units[member]?.members.length ?? 0) > 1)
  )
    return false;
  return groupUnits.every((member) =>
    (units[member]?.members ?? []).every((other) =>
      unit.members.every((person) => graph.feasible(person, other)),
    ),
  );
}

/**
 * The best existing group for one unit, or null. Used for late joiners,
 * merges and moves after a block, and for the repair step below. A group
 * qualifies when the unit fits the size cap and the filters and every member
 * of the resulting group keeps at least `minAffinity`; among those, the group
 * whose resulting worst member is best wins.
 */
export function insertIntoBestGroup(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  groups: readonly (readonly number[])[],
  unitIndex: number,
  options: {
    maxSize: number;
    minAffinity: number;
    allowedSizes?: ReadonlySet<number>;
  },
): number | null {
  const allowedSizes = options.allowedSizes ?? new Set([3, 4, 5, 6]);
  let bestGroup: number | null = null;
  let bestStats: GroupStats | null = null;
  groups.forEach((groupUnits, groupIndex) => {
    if (
      groupUnits.length === 0 ||
      !canJoin(graph, units, groupUnits, unitIndex, options.maxSize)
    )
      return;
    const stats = evaluateGroup(
      graph,
      units,
      [...groupUnits, unitIndex],
      allowedSizes,
    );
    if (stats.violations > 0 || stats.minimumAffinity < options.minAffinity)
      return;
    const isBetterCandidate =
      bestStats === null ||
      stats.minimumAffinity > bestStats.minimumAffinity + EPSILON ||
      (Math.abs(stats.minimumAffinity - bestStats.minimumAffinity) <= EPSILON &&
        stats.sumSqrt - stats.penalty > bestStats.sumSqrt - bestStats.penalty);
    if (isBetterCandidate) {
      bestGroup = groupIndex;
      bestStats = stats;
    }
  });
  return bestGroup;
}

function feasibilityDegree(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  unitIndex: number,
): number {
  const unit = units[unitIndex];
  if (!unit) return 0;
  let degree = 0;
  for (let person = 0; person < graph.size; person += 1) {
    if (unit.members.includes(person)) continue;
    if (unit.members.every((member) => graph.feasible(member, person)))
      degree += 1;
  }
  return degree;
}

function greedySeed(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  groupCount: number,
  maxSize: number,
  random: () => number,
): number[][] {
  const tieBreak = units.map(() => random());
  const order = units
    .map((_, unitIndex) => unitIndex)
    .sort(
      (first, second) =>
        feasibilityDegree(graph, units, first) -
          feasibilityDegree(graph, units, second) ||
        (tieBreak[first] ?? 0) - (tieBreak[second] ?? 0),
    );
  const groups: number[][] = Array.from({ length: groupCount }, () => []);
  for (const unitIndex of order) {
    let bestGroup = -1;
    let bestValue = -Infinity;
    groups.forEach((groupUnits, groupIndex) => {
      if (!canJoin(graph, units, groupUnits, unitIndex, maxSize)) return;
      const unit = units[unitIndex];
      if (!unit) return;
      const others = groupUnits.flatMap(
        (member) => units[member]?.members ?? [],
      );
      const value =
        others.length === 0
          ? 0.5
          : unit.members.reduce(
              (sum, person) =>
                sum +
                others.reduce(
                  (inner, other) => inner + graph.score(person, other),
                  0,
                ),
              0,
            ) /
            (unit.members.length * others.length);
      if (value > bestValue + EPSILON) {
        bestValue = value;
        bestGroup = groupIndex;
      }
    });
    if (bestGroup >= 0) groups[bestGroup]?.push(unitIndex);
  }
  return groups;
}

function anneal(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  start: number[][],
  allowedSizes: ReadonlySet<number>,
  iterations: number,
  random: () => number,
  deadline: number,
  now: () => number,
): { groups: number[][]; value: Aggregate; hitTimeBudget: boolean } {
  const groups = start.map((group) => [...group]);
  const groupOf = new Array<number>(units.length).fill(-1);
  groups.forEach((group, groupIndex) =>
    group.forEach((unitIndex) => (groupOf[unitIndex] = groupIndex)),
  );
  const stats = groups.map((group) =>
    evaluateGroup(graph, units, group, allowedSizes),
  );
  let current = aggregate(stats);
  let best = { groups: groups.map((group) => [...group]), value: current };
  const maxSize = Math.max(...allowedSizes);
  let hasHitTimeBudget = false;

  const move = (unitIndex: number, target: number): void => {
    const source = groupOf[unitIndex] ?? -1;
    if (source >= 0) {
      const sourceGroup = groups[source] ?? [];
      sourceGroup.splice(sourceGroup.indexOf(unitIndex), 1);
    }
    if (target >= 0) groups[target]?.push(unitIndex);
    groupOf[unitIndex] = target;
  };
  const refresh = (groupIndex: number): void => {
    if (groupIndex >= 0)
      stats[groupIndex] = evaluateGroup(
        graph,
        units,
        groups[groupIndex] ?? [],
        allowedSizes,
      );
  };

  for (let step = 0; step < iterations; step += 1) {
    if ((step & 255) === 0 && now() > deadline) {
      hasHitTimeBudget = true;
      break;
    }
    const temperature = 0.5 * Math.pow(0.002, step / Math.max(1, iterations));
    const firstUnit = Math.floor(random() * units.length);
    const firstGroup = groupOf[firstUnit] ?? -1;
    const shouldSwap = random() < 0.5;
    let secondUnit = -1;
    let targetGroup: number;
    if (shouldSwap) {
      secondUnit = Math.floor(random() * units.length);
      if (secondUnit === firstUnit || groupOf[secondUnit] === firstGroup)
        continue;
      targetGroup = groupOf[secondUnit] ?? -1;
    } else {
      targetGroup = Math.floor(random() * (groups.length + 1)) - 1;
      if (targetGroup === firstGroup) continue;
      const targetPeople = (groups[targetGroup] ?? []).reduce(
        (sum, member) => sum + (units[member]?.members.length ?? 0),
        0,
      );
      if (
        targetGroup >= 0 &&
        targetPeople + (units[firstUnit]?.members.length ?? 0) > maxSize
      )
        continue;
    }

    move(firstUnit, targetGroup);
    if (shouldSwap) move(secondUnit, firstGroup);
    refresh(firstGroup);
    refresh(targetGroup);
    const candidate = aggregate(stats);
    const delta = scalar(candidate, graph.size) - scalar(current, graph.size);
    if (delta >= 0 || random() < Math.exp(delta / temperature)) {
      current = candidate;
      if (isBetter(current, best.value))
        best = { groups: groups.map((group) => [...group]), value: current };
    } else {
      if (shouldSwap) move(secondUnit, targetGroup);
      move(firstUnit, firstGroup);
      refresh(firstGroup);
      refresh(targetGroup);
    }
  }
  return { ...best, hitTimeBudget: hasHitTimeBudget };
}

function solveExact(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  allowedSizes: ReadonlySet<number>,
): number[][] {
  const maxSize = Math.max(...allowedSizes);
  let bestGroups: number[][] = [];
  let bestValue: Aggregate | null = null;
  const groups: number[][] = [];
  const visit = (unitIndex: number): void => {
    if (unitIndex === units.length) {
      const value = aggregate(
        groups.map((group) => evaluateGroup(graph, units, group, allowedSizes)),
      );
      if (bestValue === null || isBetter(value, bestValue)) {
        bestValue = value;
        bestGroups = groups.map((group) => [...group]);
      }
      return;
    }
    const unitSize = units[unitIndex]?.members.length ?? 0;
    visit(unitIndex + 1);
    for (const group of groups) {
      const people = group.reduce(
        (sum, member) => sum + (units[member]?.members.length ?? 0),
        0,
      );
      if (people + unitSize > maxSize) continue;
      group.push(unitIndex);
      visit(unitIndex + 1);
      group.pop();
    }
    groups.push([unitIndex]);
    visit(unitIndex + 1);
    groups.pop();
  };
  visit(0);
  return bestGroups;
}

/** Dissolve broken groups, drop members under the floor, then re-place leftovers. */
function repair(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  proposed: number[][],
  allowedSizes: ReadonlySet<number>,
  minAffinity: number,
): { groups: number[][]; unmatched: number[] } {
  const unitIndexesInProposal = new Set(proposed.flat());
  const unmatched: number[] = [];
  for (let unitIndex = 0; unitIndex < units.length; unitIndex += 1) {
    if (!unitIndexesInProposal.has(unitIndex)) unmatched.push(unitIndex);
  }
  let groups = proposed
    .filter((group) => group.length > 0)
    .map((group) => [...group]);
  groups = groups.filter((group) => {
    const isValid =
      evaluateGroup(graph, units, group, allowedSizes).violations === 0;
    if (!isValid) unmatched.push(...group);
    return isValid;
  });
  for (const group of groups) {
    for (;;) {
      const affinities = personAffinities(graph, units, group);
      let worstPerson = -1;
      let worstAffinity = Infinity;
      for (const [person, affinity] of affinities) {
        if (affinity < worstAffinity) {
          worstAffinity = affinity;
          worstPerson = person;
        }
      }
      if (worstAffinity >= minAffinity) break;
      const worstUnit = group.find((unitIndex) =>
        units[unitIndex]?.members.includes(worstPerson),
      );
      if (worstUnit === undefined) break;
      group.splice(group.indexOf(worstUnit), 1);
      unmatched.push(worstUnit);
    }
  }
  groups = groups.filter((group) => {
    const isValid =
      group.length > 0 &&
      evaluateGroup(graph, units, group, allowedSizes).violations === 0;
    if (!isValid) unmatched.push(...group);
    return isValid;
  });
  const maxSize = Math.max(...allowedSizes);
  const stillUnmatched: number[] = [];
  for (const unitIndex of unmatched.sort((first, second) => first - second)) {
    const target = insertIntoBestGroup(graph, units, groups, unitIndex, {
      maxSize,
      minAffinity,
      allowedSizes,
    });
    if (target === null) stillUnmatched.push(unitIndex);
    else groups[target]?.push(unitIndex);
  }
  return { groups, unmatched: stillUnmatched };
}

export function formGroups(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  options: GroupingOptions,
): GroupingResult {
  const now = options.now ?? (() => Date.now());
  const personCount = units.reduce((sum, unit) => sum + unit.members.length, 0);
  const plan = planGroupSizes(personCount);
  const empty: GroupingResult = {
    groups: [],
    unmatchedUnits: units.map((_, unitIndex) => unitIndex),
    affinity: new Map(),
    groupMinimumAffinity: [],
    hitTimeBudget: false,
  };
  if (plan.length === 0) return empty;
  const allowedSizes = allowedSizesFor(plan);

  let proposed: number[][];
  let hasHitTimeBudget = false;
  if (personCount <= EXACT_POOL_LIMIT) {
    proposed = solveExact(graph, units, allowedSizes);
  } else {
    const restarts = options.restarts ?? 20;
    const iterations =
      options.iterationsPerRestart ?? Math.min(20000, 400 * units.length);
    const deadline = now() + (options.timeBudgetMs ?? 2000);
    const maxSize = Math.max(...allowedSizes);
    let best: { groups: number[][]; value: Aggregate } | null = null;
    for (let restart = 0; restart < restarts; restart += 1) {
      const random = createRandom(options.seed + restart * 7919);
      const seeded = greedySeed(graph, units, plan.length, maxSize, random);
      const result = anneal(
        graph,
        units,
        seeded,
        allowedSizes,
        iterations,
        random,
        deadline,
        now,
      );
      hasHitTimeBudget = hasHitTimeBudget || result.hitTimeBudget;
      if (best === null || isBetter(result.value, best.value)) best = result;
      if (result.hitTimeBudget) break;
    }
    proposed = best?.groups ?? [];
  }

  const repaired = repair(
    graph,
    units,
    proposed,
    allowedSizes,
    options.minAffinity,
  );
  const affinity = new Map<number, number>();
  const groupMinimumAffinity = repaired.groups.map((group) => {
    const affinities = personAffinities(graph, units, group);
    affinities.forEach((value, person) => affinity.set(person, value));
    return Math.min(...affinities.values());
  });
  return {
    groups: repaired.groups,
    unmatchedUnits: repaired.unmatched,
    affinity,
    groupMinimumAffinity,
    hitTimeBudget: hasHitTimeBudget,
  };
}
