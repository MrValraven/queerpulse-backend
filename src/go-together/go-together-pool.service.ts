import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import {
  Connection,
  ConnectionStatus,
} from '../connections/entities/connection.entity';
import { Block } from '../social/entities/block.entity';
import { EventMatchEntry } from './entities/event-match-entry.entity';
import { EventMatchGroup } from './entities/event-match-group.entity';
import { FriendMatchProfile } from './entities/friend-match-profile.entity';
import { MatchAvoidance } from './entities/match-avoidance.entity';
import {
  MatchFeedback,
  MeetAgainVerdict,
} from './entities/match-feedback.entity';
import { MatchGroupFeedback } from './entities/match-group-feedback.entity';
import { MatchGraph, MatchUnit } from './go-together-grouping';
import {
  ComponentScores,
  MatchCandidate,
  PairContext,
  computeInterestIdf,
  isPairFeasible,
  pairKey,
  scorePair,
} from './go-together-scoring';

const ANCHOR_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_ANCHOR_SIZE = 3;
const WARM_VERDICTS: readonly MeetAgainVerdict[] = ['yes', 'maybe'];

/** Score and components for any pair involving a seated member who has no
 *  questionnaire answers any more. */
export const NEUTRAL_SCORE = 0.5;
const NEUTRAL_COMPONENTS: ComponentScores = {
  values: NEUTRAL_SCORE,
  interests: NEUTRAL_SCORE,
  energyIntent: NEUTRAL_SCORE,
  humour: NEUTRAL_SCORE,
  music: NEUTRAL_SCORE,
  ageArea: NEUTRAL_SCORE,
  hostBonus: 0,
};

export interface PoolMember {
  entry: EventMatchEntry;
  /**
   * Null for a member seated in a group (`status: 'grouped'`) whose
   * questionnaire is gone. They stay in the pool so their seat counts toward
   * the group size and their blocks and avoidances still apply; they are
   * feasible with everyone else and score `NEUTRAL_SCORE`.
   */
  candidate: MatchCandidate | null;
}

/** Where an entry sits right now: its group when seated, otherwise pending. */
export function placeOf(entry: EventMatchEntry): string {
  return entry.status === 'grouped' && entry.groupId !== null
    ? `group:${entry.groupId}`
    : 'pending';
}

export interface MatchPool {
  members: PoolMember[];
  indexByUserId: Map<string, number>;
  units: MatchUnit[];
  graph: MatchGraph;
  context: PairContext;
  componentsFor(first: number, second: number): ComponentScores;
}

/**
 * Loads everything the pure engine needs for one set of entries, in a fixed
 * number of batched queries: answers, the interest IDF over every profile,
 * blocks, avoidances and connections among the members, and past-group
 * "go together again" anchors. The score and feasibility matrices are
 * computed once here so the solver never touches the database.
 */
@Injectable()
export class GoTogetherPoolService {
  constructor(
    @InjectRepository(FriendMatchProfile)
    private readonly profiles: Repository<FriendMatchProfile>,
    @InjectRepository(Block) private readonly blocks: Repository<Block>,
    @InjectRepository(MatchAvoidance)
    private readonly avoidances: Repository<MatchAvoidance>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(EventMatchGroup)
    private readonly groups: Repository<EventMatchGroup>,
    @InjectRepository(MatchFeedback)
    private readonly feedback: Repository<MatchFeedback>,
    @InjectRepository(MatchGroupFeedback)
    private readonly groupFeedback: Repository<MatchGroupFeedback>,
  ) {}

  async buildPool(
    poolEntries: EventMatchEntry[],
    options: { includeAnchors: boolean; now?: Date },
  ): Promise<{ pool: MatchPool; skippedEntryIds: string[] }> {
    const userIds = poolEntries.map((entry) => entry.userId);
    const [
      profileRows,
      interestRows,
      blockRows,
      avoidanceRows,
      connectionRows,
    ] = await Promise.all([
      this.profiles.find({ where: { userId: In(userIds) } }),
      this.profiles
        .createQueryBuilder('profile')
        .select(`profile.answers -> 'interests'`, 'interests')
        .getRawMany<{ interests: string[] | null }>(),
      this.blocks.find({
        where: { blockerId: In(userIds), blockedId: In(userIds) },
        select: { blockerId: true, blockedId: true },
      }),
      this.avoidances.find({
        where: { userId: In(userIds), avoidedUserId: In(userIds) },
        select: { userId: true, avoidedUserId: true },
      }),
      this.connections.find({
        where: {
          userLow: In(userIds),
          userHigh: In(userIds),
          status: ConnectionStatus.Accepted,
        },
        select: { userLow: true, userHigh: true },
      }),
    ]);
    const profileByUser = new Map(profileRows.map((row) => [row.userId, row]));
    const skippedEntryIds: string[] = [];
    const members: PoolMember[] = [];
    for (const entry of poolEntries) {
      const profile = profileByUser.get(entry.userId);
      if (!profile) {
        if (entry.status === 'grouped' && entry.groupId !== null) {
          members.push({ entry, candidate: null });
        } else {
          skippedEntryIds.push(entry.id);
        }
        continue;
      }
      members.push({
        entry,
        candidate: {
          userId: entry.userId,
          answers: profile.answers,
          hostAnswers: entry.hostAnswers,
          lens: entry.lens,
        },
      });
    }

    const context: PairContext = {
      interestIdf: computeInterestIdf(
        interestRows.map((row) => row.interests ?? []),
      ),
      blockedPairs: new Set(
        blockRows.map((row) => pairKey(row.blockerId, row.blockedId)),
      ),
      avoidedPairs: new Set(
        avoidanceRows.map((row) => pairKey(row.userId, row.avoidedUserId)),
      ),
      connectedPairs: new Set(
        connectionRows.map((row) => pairKey(row.userLow, row.userHigh)),
      ),
    };

    const size = members.length;
    const scores = new Float64Array(size * size);
    const feasible = new Uint8Array(size * size);
    for (let first = 0; first < size; first += 1) {
      for (let second = first + 1; second < size; second += 1) {
        const firstCandidate = members[first]!.candidate;
        const secondCandidate = members[second]!.candidate;
        let isFeasible: boolean;
        let score: number;
        if (firstCandidate && secondCandidate) {
          isFeasible = isPairFeasible(firstCandidate, secondCandidate, context);
          score = scorePair(firstCandidate, secondCandidate, context).score;
        } else {
          const key = pairKey(
            members[first]!.entry.userId,
            members[second]!.entry.userId,
          );
          isFeasible =
            !context.blockedPairs.has(key) && !context.avoidedPairs.has(key);
          score = NEUTRAL_SCORE;
        }
        scores[first * size + second] = scores[second * size + first] = score;
        feasible[first * size + second] = feasible[second * size + first] =
          isFeasible ? 1 : 0;
      }
    }
    const indexByUserId = new Map(
      members.map((member, index) => [member.entry.userId, index]),
    );
    const graph: MatchGraph = {
      size,
      score: (first, second) => scores[first * size + second] ?? 0,
      feasible: (first, second) => feasible[first * size + second] === 1,
      isTalker: (person) =>
        (members[person]?.candidate?.answers.energy.talker ?? 0) >= 4,
      connected: (first, second) =>
        context.connectedPairs.has(
          pairKey(members[first]!.entry.userId, members[second]!.entry.userId),
        ),
    };

    const units = this.buildUnits(members, indexByUserId, graph);
    const anchoredUnits = options.includeAnchors
      ? await this.applyAnchors(
          units,
          members,
          graph,
          options.now ?? new Date(),
        )
      : units;

    return {
      pool: {
        members,
        indexByUserId,
        units: anchoredUnits,
        graph,
        context,
        componentsFor: (first, second) => {
          const firstCandidate = members[first]?.candidate;
          const secondCandidate = members[second]?.candidate;
          return firstCandidate && secondCandidate
            ? scorePair(firstCandidate, secondCandidate, context).components
            : { ...NEUTRAL_COMPONENTS };
        },
      },
      skippedEntryIds,
    };
  }

  /**
   * Accepted pairs whose partner is also in the pool, and who sit in the same
   * place right now, become one unit; everyone else is a solo. "Same place"
   * means both seated in one group, or both still pending, so a unit never
   * spans two groups or a group and the pending list.
   */
  private buildUnits(
    members: PoolMember[],
    indexByUserId: Map<string, number>,
    graph: MatchGraph,
  ): MatchUnit[] {
    const placed = new Set<number>();
    const units: MatchUnit[] = [];
    members.forEach((member, index) => {
      if (placed.has(index)) return;
      const partnerIndex =
        member.entry.pairStatus === 'accepted' && member.entry.pairPartnerId
          ? indexByUserId.get(member.entry.pairPartnerId)
          : undefined;
      const partnerEntry =
        partnerIndex === undefined ? undefined : members[partnerIndex]?.entry;
      const isMutualPair =
        partnerIndex !== undefined &&
        !placed.has(partnerIndex) &&
        partnerEntry?.pairStatus === 'accepted' &&
        partnerEntry.pairPartnerId === member.entry.userId &&
        placeOf(partnerEntry) === placeOf(member.entry) &&
        graph.feasible(index, partnerIndex);
      if (isMutualPair && partnerIndex !== undefined) {
        units.push({ id: member.entry.id, members: [index, partnerIndex] });
        placed.add(index);
        placed.add(partnerIndex);
      } else {
        units.push({ id: member.entry.id, members: [index] });
        placed.add(index);
      }
    });
    return units;
  }

  /**
   * Regroup anchors: solos who shared a recent group, all ticked "go together
   * again" for it, and rated each other Yes or Maybe in both directions are
   * kept together as one unit of up to three. Groups are visited newest
   * first, and each solo joins at most one anchor.
   */
  private async applyAnchors(
    units: MatchUnit[],
    members: PoolMember[],
    graph: MatchGraph,
    now: Date,
  ): Promise<MatchUnit[]> {
    const soloIndexByUserId = new Map<string, number>();
    for (const unit of units) {
      const person = unit.members[0];
      const member = person === undefined ? undefined : members[person];
      if (
        unit.members.length === 1 &&
        person !== undefined &&
        member?.candidate
      ) {
        soloIndexByUserId.set(member.entry.userId, person);
      }
    }
    if (soloIndexByUserId.size < 2) return units;
    const soloUserIds = [...soloIndexByUserId.keys()];

    const goAgainRows = await this.groupFeedback.find({
      where: { raterId: In(soloUserIds), goAgain: true },
      select: { groupId: true, raterId: true },
    });
    if (goAgainRows.length === 0) return units;
    const lookbackStart = new Date(now.getTime() - ANCHOR_LOOKBACK_MS);
    const recentGroups = await this.groups.find({
      where: {
        id: In([...new Set(goAgainRows.map((row) => row.groupId))]),
        formedAt: MoreThan(lookbackStart),
      },
      select: { id: true, formedAt: true },
    });
    if (recentGroups.length === 0) return units;
    recentGroups.sort(
      (first, second) =>
        second.formedAt.getTime() - first.formedAt.getTime() ||
        first.id.localeCompare(second.id),
    );

    const verdictRows = await this.feedback.find({
      where: {
        groupId: In(recentGroups.map((group) => group.id)),
        raterId: In(soloUserIds),
        rateeId: In(soloUserIds),
      },
      select: { groupId: true, raterId: true, rateeId: true, verdict: true },
    });
    const verdictByKey = new Map(
      verdictRows.map((row) => [
        `${row.groupId}:${row.raterId}:${row.rateeId}`,
        row.verdict,
      ]),
    );
    const goAgainRatersByGroup = new Map<string, string[]>();
    for (const row of goAgainRows) {
      const raters = goAgainRatersByGroup.get(row.groupId) ?? [];
      raters.push(row.raterId);
      goAgainRatersByGroup.set(row.groupId, raters);
    }

    const userIdOf = (person: number): string =>
      members[person]?.entry.userId ?? '';
    const anchoredPeople = new Set<number>();
    const anchors: number[][] = [];
    for (const group of recentGroups) {
      const isWarmPair = (first: number, second: number): boolean => {
        const firstVerdict = verdictByKey.get(
          `${group.id}:${userIdOf(first)}:${userIdOf(second)}`,
        );
        const secondVerdict = verdictByKey.get(
          `${group.id}:${userIdOf(second)}:${userIdOf(first)}`,
        );
        return (
          graph.feasible(first, second) &&
          firstVerdict !== undefined &&
          secondVerdict !== undefined &&
          WARM_VERDICTS.includes(firstVerdict) &&
          WARM_VERDICTS.includes(secondVerdict)
        );
      };
      const candidates = [...new Set(goAgainRatersByGroup.get(group.id) ?? [])]
        .map((userId) => soloIndexByUserId.get(userId))
        .filter(
          (person): person is number =>
            person !== undefined && !anchoredPeople.has(person),
        )
        .sort((first, second) => first - second);
      const clique = this.bestWarmClique(candidates, graph, isWarmPair);
      if (clique.length < 2) continue;
      clique.forEach((person) => anchoredPeople.add(person));
      anchors.push(clique.sort((first, second) => first - second));
    }
    if (anchors.length === 0) return units;

    const anchorByPerson = new Map<number, number[]>();
    for (const anchor of anchors) {
      for (const person of anchor) anchorByPerson.set(person, anchor);
    }
    const emittedAnchors = new Set<number[]>();
    const anchoredUnits: MatchUnit[] = [];
    for (const unit of units) {
      const person = unit.members[0];
      const anchor =
        unit.members.length === 1 && person !== undefined
          ? anchorByPerson.get(person)
          : undefined;
      if (!anchor) {
        anchoredUnits.push(unit);
        continue;
      }
      if (emittedAnchors.has(anchor)) continue;
      emittedAnchors.add(anchor);
      const firstMember = anchor[0];
      anchoredUnits.push({
        id:
          firstMember === undefined
            ? unit.id
            : (members[firstMember]?.entry.id ?? unit.id),
        members: [...anchor],
      });
    }
    return anchoredUnits;
  }

  /** Greedy: the highest-scoring warm pair, then a third member warm with both. */
  private bestWarmClique(
    candidates: readonly number[],
    graph: MatchGraph,
    isWarmPair: (first: number, second: number) => boolean,
  ): number[] {
    let bestPair: number[] = [];
    let bestScore = -Infinity;
    for (let firstSlot = 0; firstSlot < candidates.length; firstSlot += 1) {
      for (
        let secondSlot = firstSlot + 1;
        secondSlot < candidates.length;
        secondSlot += 1
      ) {
        const first = candidates[firstSlot]!;
        const second = candidates[secondSlot]!;
        if (!isWarmPair(first, second)) continue;
        const score = graph.score(first, second);
        if (score > bestScore) {
          bestScore = score;
          bestPair = [first, second];
        }
      }
    }
    const clique = [...bestPair];
    while (clique.length >= 2 && clique.length < MAX_ANCHOR_SIZE) {
      let bestThird: number | null = null;
      let bestThirdScore = -Infinity;
      for (const candidate of candidates) {
        if (clique.includes(candidate)) continue;
        if (!clique.every((member) => isWarmPair(member, candidate))) continue;
        const score = clique.reduce(
          (sum, member) => sum + graph.score(member, candidate),
          0,
        );
        if (score > bestThirdScore) {
          bestThirdScore = score;
          bestThird = candidate;
        }
      }
      if (bestThird === null) break;
      clique.push(bestThird);
    }
    return clique;
  }
}
