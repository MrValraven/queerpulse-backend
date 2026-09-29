import type { EventMatchEntry } from './entities/event-match-entry.entity';
import {
  MatchGraph,
  MatchUnit,
  insertIntoBestGroup,
} from './go-together-grouping';
import type { MatchPool } from './go-together-pool.service';
import { ComponentScores, pairKey } from './go-together-scoring';

/**
 * Pure index bookkeeping for the formation service. The solver speaks in
 * person indexes and unit indexes; the database speaks in entries and group
 * ids. These helpers translate between the two for one built pool.
 */

/**
 * Whether the gathering is still ahead, the one line every "after the start"
 * rule reads: leaving, merge offers and moving after a block. A gathering
 * that can no longer be read counts as started, so nobody is reseated or
 * offered a merge into a gathering that is gone. A true answer also tells
 * the compiler the gathering was read.
 */
export function isGatheringUpcoming<Gathering extends { startAt: Date }>(
  gathering: Gathering | null,
  now: Date,
): gathering is Gathering {
  return gathering !== null && gathering.startAt.getTime() > now.getTime();
}

/** A block still moves people this long after the gathering started; past
 *  it, the two are only hidden from each other on the card. */
export const BLOCK_MOVE_GRACE_MS = 12 * 60 * 60 * 1000;

/** Whether a block between groupmates came too late to move anyone: the
 *  gathering started more than {@link BLOCK_MOVE_GRACE_MS} ago. A gathering
 *  that can no longer be read is not past it. */
export function isPastBlockMoveGrace(
  gathering: { startAt: Date } | null,
  now: Date,
): boolean {
  return (
    gathering !== null &&
    gathering.startAt.getTime() <= now.getTime() - BLOCK_MOVE_GRACE_MS
  );
}

/** The negation of {@link isGatheringUpcoming}, for reads that only need
 *  the answer. */
export function hasGatheringStarted(
  gathering: { startAt: Date } | null,
  now: Date,
): boolean {
  return !isGatheringUpcoming(gathering, now);
}

/** The entries behind one unit, in unit order. */
export function unitEntries(
  pool: MatchPool,
  unitIndex: number,
): EventMatchEntry[] {
  return (pool.units[unitIndex]?.members ?? []).flatMap((person) => {
    const member = pool.members[person];
    return member ? [member.entry] : [];
  });
}

/** Unit indexes whose every member's entry satisfies `isIncluded`. */
export function unitIndexesWhere(
  pool: MatchPool,
  isIncluded: (entry: EventMatchEntry) => boolean,
): number[] {
  return pool.units.flatMap((unit, unitIndex) => {
    const isEveryMemberIncluded = unit.members.every((person) => {
      const member = pool.members[person];
      return member !== undefined && isIncluded(member.entry);
    });
    return isEveryMemberIncluded ? [unitIndex] : [];
  });
}

/** One unit-index list per group id, aligned with `groupIds`: every unit
 *  whose members are all grouped in that group. */
export function groupUnitLists(
  pool: MatchPool,
  groupIds: readonly string[],
): number[][] {
  return groupIds.map((groupId) =>
    unitIndexesWhere(
      pool,
      (entry) => entry.status === 'grouped' && entry.groupId === groupId,
    ),
  );
}

/** Flattens a solver group (unit indexes) into person indexes. */
export function personIndexesOf(
  units: readonly MatchUnit[],
  unitIndexes: readonly number[],
): number[] {
  return unitIndexes.flatMap((unitIndex) => units[unitIndex]?.members ?? []);
}

/** Every unit that no solver group holds. The solver may leave a unit out of
 *  both its groups and its unmatched list, so this is computed from the
 *  groups alone. */
export function unplacedUnitIndexes(
  unitCount: number,
  groups: readonly (readonly number[])[],
): number[] {
  const placed = new Set(groups.flat());
  return Array.from({ length: unitCount }, (_, unitIndex) => unitIndex).filter(
    (unitIndex) => !placed.has(unitIndex),
  );
}

/** How many people in the pool could share a group with every member of the unit. */
export function feasiblePartnerCount(
  graph: MatchGraph,
  unit: MatchUnit,
): number {
  let count = 0;
  for (let person = 0; person < graph.size; person += 1) {
    if (unit.members.includes(person)) continue;
    if (unit.members.every((member) => graph.feasible(member, person)))
      count += 1;
  }
  return count;
}

/** Hardest first: fewest feasible partners, ties broken by unit id. */
export function orderHardestFirst(
  pool: MatchPool,
  unitIndexes: readonly number[],
): number[] {
  const partnerCounts = new Map(
    unitIndexes.map((unitIndex) => {
      const unit = pool.units[unitIndex];
      return [unitIndex, unit ? feasiblePartnerCount(pool.graph, unit) : 0];
    }),
  );
  return [...unitIndexes].sort(
    (first, second) =>
      (partnerCounts.get(first) ?? 0) - (partnerCounts.get(second) ?? 0) ||
      (pool.units[first]?.id ?? '').localeCompare(pool.units[second]?.id ?? ''),
  );
}

export interface Placement {
  unitIndex: number;
  groupIndex: number;
}

/**
 * Finds a group for each unit in turn with `insertIntoBestGroup`. With
 * `shouldReserveSeats`, a placed unit is pushed into its group's list so the
 * next unit sees the seat taken; without it, every unit is judged against the
 * groups as they are (merge offers, which may never be accepted).
 */
export function planPlacements(
  pool: MatchPool,
  groupLists: number[][],
  unitIndexes: readonly number[],
  options: {
    maxSize: number;
    minAffinity: number;
    shouldReserveSeats: boolean;
  },
): Placement[] {
  const placements: Placement[] = [];
  for (const unitIndex of unitIndexes) {
    const groupIndex = insertIntoBestGroup(
      pool.graph,
      pool.units,
      groupLists,
      unitIndex,
      { maxSize: options.maxSize, minAffinity: options.minAffinity },
    );
    if (groupIndex === null) continue;
    placements.push({ unitIndex, groupIndex });
    if (options.shouldReserveSeats) groupLists[groupIndex]?.push(unitIndex);
  }
  return placements;
}

/**
 * The worst-off member's affinity: their mean score to everyone in the group
 * outside their own unit, so a pair's score to each other never lifts it
 * (spec 5.3). The same measure the solver reports as `groupMinimumAffinity`.
 * A member with nobody outside their unit counts as 0, like the solver.
 */
export function groupMinimumAffinity(
  graph: MatchGraph,
  units: readonly MatchUnit[],
  personIndexes: readonly number[],
): number {
  if (personIndexes.length < 2) return 0;
  const unitIndexByPerson = new Map<number, number>();
  units.forEach((unit, unitIndex) => {
    for (const person of unit.members) unitIndexByPerson.set(person, unitIndex);
  });
  const isSameUnit = (person: number, other: number): boolean => {
    const unitIndex = unitIndexByPerson.get(person);
    return (
      unitIndex !== undefined && unitIndex === unitIndexByPerson.get(other)
    );
  };
  return Math.min(
    ...personIndexes.map((person) => {
      const others = personIndexes.filter(
        (other) => other !== person && !isSameUnit(person, other),
      );
      if (others.length === 0) return 0;
      return (
        others.reduce((sum, other) => sum + graph.score(person, other), 0) /
        others.length
      );
    }),
  );
}

/** Component scores for every member pair of a group, keyed by `pairKey`. */
export function buildPairComponents(
  pool: MatchPool,
  personIndexes: readonly number[],
): Record<string, ComponentScores> {
  const components: Record<string, ComponentScores> = {};
  for (let firstSlot = 0; firstSlot < personIndexes.length; firstSlot += 1) {
    for (
      let secondSlot = firstSlot + 1;
      secondSlot < personIndexes.length;
      secondSlot += 1
    ) {
      const first = personIndexes[firstSlot]!;
      const second = personIndexes[secondSlot]!;
      const firstMember = pool.members[first];
      const secondMember = pool.members[second];
      if (!firstMember || !secondMember) continue;
      components[pairKey(firstMember.entry.userId, secondMember.entry.userId)] =
        pool.componentsFor(first, second);
    }
  }
  return components;
}
