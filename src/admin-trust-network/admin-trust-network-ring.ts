import type { Standing } from './admin-trust-network-response';

/** One graph node's ring-detection inputs — the subset of `TrustNodeDTO`
 *  `detectRingSlugs` actually reads. */
export interface RingCandidateNode {
  /** The graph node key (`TrustNodeDTO.id`/`slug`) — matches
   *  `TrustEdgeDTO.from`/`to`. */
  id: string;
  verified: boolean;
  standing: Standing;
}

/** One vouch edge's ring-detection inputs — the subset of `TrustEdgeDTO`
 *  `detectRingSlugs` actually reads. */
export interface RingCandidateEdge {
  from: string;
  to: string;
  withdrawn: boolean;
}

/**
 * ADM-23: real ring/cluster detection, replacing the `standing === 'flagged'`
 * heuristic the ring visual used to key off. `standing === 'flagged'` means
 * "suspended, frozen, or carrying 2+ open reports" (`standingFor`, above) —
 * a real signal, but not the same thing as "part of a closed self-vouching
 * loop", and it is left untouched here for its own purpose.
 *
 * A ring is a strongly-connected component (size >= 3) of NEW/UNVERIFIED
 * accounts among ACTIVE vouch edges: everyone in it can reach everyone else
 * in it and be reached back — a closed loop with no way out that isn't
 * itself a member. Size 2 (a plain reciprocal/mutual vouch) is excluded on
 * purpose: two accounts vouching for each other is normal and already has
 * its own `mutual` edge flag — a ring is specifically the seed fixture's
 * "N accounts vouching only for each other" shape, length >= 3.
 *
 * The whole loop is disqualified — nobody in it is marked `inRing` — the
 * moment ANY member has an active inbound vouch from a node OUTSIDE the loop
 * that is itself verified or trusted-standing: real outside vindication
 * breaks the "closed loop with no outside trust" premise for the WHOLE
 * cluster, not just the one vouched-for member.
 *
 * Tarjan's strongly-connected-components algorithm over the small
 * (`MAX_NODES`-capped, sparse) candidate subgraph — no graph library, and
 * mirrors the plain-BFS style the frontend's `trustGraphModel.ts`
 * (`shortestPath`/`isIsolated`) already uses for graph queries this size.
 */
export function detectRingSlugs(
  nodes: RingCandidateNode[],
  edges: RingCandidateEdge[],
): Set<string> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const candidateIds = new Set(
    nodes.filter((node) => !node.verified).map((node) => node.id),
  );

  // Out-edges restricted to the candidate pool (feeds SCC discovery) and the
  // full inbound-edge map (needed for the outside-trust check, which must
  // see vouches from OUTSIDE the candidate pool too).
  const candidateOutEdgesByNode = new Map<string, string[]>();
  const inboundActiveEdgesByTarget = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.withdrawn) continue;
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    if (candidateIds.has(edge.from) && candidateIds.has(edge.to)) {
      const outList = candidateOutEdgesByNode.get(edge.from) ?? [];
      outList.push(edge.to);
      candidateOutEdgesByNode.set(edge.from, outList);
    }
    const inboundList = inboundActiveEdgesByTarget.get(edge.to) ?? [];
    inboundList.push(edge.from);
    inboundActiveEdgesByTarget.set(edge.to, inboundList);
  }

  const stronglyConnectedComponents = tarjanStronglyConnectedComponents(
    candidateIds,
    candidateOutEdgesByNode,
  );

  const ringSlugs = new Set<string>();
  for (const component of stronglyConnectedComponents) {
    if (component.size < 3) continue;
    const hasOutsideTrustedInbound = [...component].some((memberId) => {
      const inboundFrom = inboundActiveEdgesByTarget.get(memberId) ?? [];
      return inboundFrom.some((sourceId) => {
        if (component.has(sourceId)) return false; // inside the loop
        const sourceNode = nodeById.get(sourceId);
        if (!sourceNode) return false;
        return sourceNode.verified || sourceNode.standing === 'trusted';
      });
    });
    if (hasOutsideTrustedInbound) continue;
    for (const memberId of component) ringSlugs.add(memberId);
  }
  return ringSlugs;
}

/**
 * Tarjan's strongly-connected-components — every node id ends up in exactly
 * one returned `Set`. Recursive: safe here because the candidate pool is
 * `MAX_NODES`-capped and vouch graphs are sparse, so recursion depth stays
 * far below any real stack limit.
 */
function tarjanStronglyConnectedComponents(
  nodeIds: Set<string>,
  outEdgesByNode: Map<string, string[]>,
): Set<string>[] {
  let nextIndex = 0;
  const indexById = new Map<string, number>();
  const lowlinkById = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: Set<string>[] = [];

  function strongConnect(nodeId: string): void {
    indexById.set(nodeId, nextIndex);
    lowlinkById.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);

    for (const neighborId of outEdgesByNode.get(nodeId) ?? []) {
      if (!indexById.has(neighborId)) {
        strongConnect(neighborId);
        lowlinkById.set(
          nodeId,
          Math.min(lowlinkById.get(nodeId)!, lowlinkById.get(neighborId)!),
        );
      } else if (onStack.has(neighborId)) {
        lowlinkById.set(
          nodeId,
          Math.min(lowlinkById.get(nodeId)!, indexById.get(neighborId)!),
        );
      }
    }

    if (lowlinkById.get(nodeId) === indexById.get(nodeId)) {
      const component = new Set<string>();
      let memberId: string | undefined;
      do {
        memberId = stack.pop();
        if (memberId === undefined) break;
        onStack.delete(memberId);
        component.add(memberId);
      } while (memberId !== nodeId);
      components.push(component);
    }
  }

  for (const nodeId of nodeIds) {
    if (!indexById.has(nodeId)) strongConnect(nodeId);
  }
  return components;
}
