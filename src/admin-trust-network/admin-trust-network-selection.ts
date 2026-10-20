/** Payload cap for `GET /admin/trust-network`: nodes returned per graph.
 *  `truncated` signals when it bites. */
export const MAX_NODES = 500;

/** How many vouch hops out from the focus the selection walks before it
 *  falls back to filling with the newest members. */
export const BFS_MAX_DEPTH = 3;

export interface SelectNodeUserIdsInput {
  /** The member the graph is centred on, or null for the newest-first view. */
  focusUserId: string | null;
  /** One vouch query per level, ids only, active and withdrawn, both
   *  directions. Returns the user ids on the other end of every row touching
   *  `frontier`; duplicates and already-selected ids are fine. */
  loadNeighbourUserIds: (frontier: string[]) => Promise<string[]>;
  /** joinedAt per user id, read once per level. An id missing from the
   *  result has no profile and is dropped from the selection. */
  loadJoinedAtByUserId: (userIds: string[]) => Promise<Map<string, Date>>;
  /** Newest-joined user ids first, skipping `excludeUserIds`, at most `take`. */
  loadNewestUserIds: (
    excludeUserIds: string[],
    take: number,
  ) => Promise<string[]>;
}

/**
 * B10 node selection. With a focus: the focus first, then a level-wise BFS
 * over every vouch row (active and withdrawn, both directions) up to
 * `BFS_MAX_DEPTH` hops. Each level keeps only ids that have a profile, so a
 * vouch row pointing at a missing account never takes a node slot. A level
 * that would overflow `MAX_NODES` keeps its newest-joined members up to the
 * cap. Any capacity left over fills with the
 * newest members outside the selected set. Without a focus: newest first.
 *
 * Neighbours first means an old member's old connections stay in view even
 * when hundreds of newer profiles exist.
 */
export async function selectNodeUserIds(
  input: SelectNodeUserIdsInput,
): Promise<string[]> {
  if (input.focusUserId === null) {
    return uniqueInOrder(await input.loadNewestUserIds([], MAX_NODES)).slice(
      0,
      MAX_NODES,
    );
  }

  const selectedUserIds: string[] = [input.focusUserId];
  const selectedSet = new Set(selectedUserIds);
  let frontier: string[] = [input.focusUserId];

  for (
    let depth = 1;
    depth <= BFS_MAX_DEPTH &&
    frontier.length > 0 &&
    selectedUserIds.length < MAX_NODES;
    depth += 1
  ) {
    const neighbourUserIds = await input.loadNeighbourUserIds(frontier);
    const candidateUserIds = uniqueInOrder(neighbourUserIds).filter(
      (userId) => !selectedSet.has(userId),
    );
    const joinedAtByUserId = candidateUserIds.length
      ? await input.loadJoinedAtByUserId(candidateUserIds)
      : new Map<string, Date>();
    const levelUserIds = candidateUserIds.filter((userId) =>
      joinedAtByUserId.has(userId),
    );
    const capacity = MAX_NODES - selectedUserIds.length;
    const admittedUserIds =
      levelUserIds.length > capacity
        ? keepNewestJoined(levelUserIds, capacity, joinedAtByUserId)
        : levelUserIds;
    for (const userId of admittedUserIds) {
      selectedUserIds.push(userId);
      selectedSet.add(userId);
    }
    frontier = admittedUserIds;
  }

  const remainingCapacity = MAX_NODES - selectedUserIds.length;
  if (remainingCapacity > 0) {
    const fillUserIds = await input.loadNewestUserIds(
      [...selectedUserIds],
      remainingCapacity,
    );
    for (const userId of fillUserIds) {
      if (selectedUserIds.length >= MAX_NODES) break;
      if (selectedSet.has(userId)) continue;
      selectedUserIds.push(userId);
      selectedSet.add(userId);
    }
  }

  return selectedUserIds;
}

/** Trims an overflowing level to `capacity`, newest-joined first. Every id
 *  here has a joinedAt; ties break on user id for determinism. */
function keepNewestJoined(
  levelUserIds: string[],
  capacity: number,
  joinedAtByUserId: Map<string, Date>,
): string[] {
  const joinedTime = (userId: string): number =>
    joinedAtByUserId.get(userId)?.getTime() ?? 0;
  return [...levelUserIds]
    .sort((first, second) => {
      const joinedTimeDifference = joinedTime(second) - joinedTime(first);
      if (joinedTimeDifference !== 0) return joinedTimeDifference;
      return first.localeCompare(second);
    })
    .slice(0, capacity);
}

function uniqueInOrder(userIds: string[]): string[] {
  return [...new Set(userIds)];
}
