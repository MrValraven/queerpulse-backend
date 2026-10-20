import type { Standing } from './admin-trust-network-response';

/** One graph node's ring-detection inputs: the subset of `TrustNodeDTO` that
 *  `detectRings` reads. */
export interface RingCandidateNode {
  /** The node key, matching `RingCandidateEdge.from`/`to`. The graph passes
   *  the profile slug (`TrustNodeDTO.id`); the trust assessment passes the
   *  account's userId. */
  id: string;
  verified: boolean;
  standing: Standing;
}

/** One vouch edge's ring-detection inputs: the subset of `TrustEdgeDTO` that
 *  `detectRings` reads. */
export interface RingCandidateEdge {
  from: string;
  to: string;
  withdrawn: boolean;
}

/** Decides which nodes may belong to a ring at all. */
export type RingCandidatePredicate = (node: RingCandidateNode) => boolean;

/** The original candidate pool: every unverified account. */
export const isUnverifiedRingCandidate: RingCandidatePredicate = (node) =>
  !node.verified;

/**
 * ADM-23: real ring/cluster detection, replacing the `standing === 'flagged'`
 * heuristic the ring visual used to key off. `standing === 'flagged'` means
 * "suspended, frozen, or carrying 2+ open reports" (`standingFor`). That is a
 * real signal with its own purpose, and this detector leaves it untouched.
 *
 * A ring is a strongly-connected component (size >= 3) of candidate accounts
 * among ACTIVE vouch edges: everyone in it can reach everyone else in it and
 * be reached back, so it forms a closed loop whose only exits lead back to
 * its own members. Size 2 (a plain reciprocal vouch) is excluded on purpose:
 * two accounts vouching for each other is normal and already has its own
 * `mutual` edge flag. A ring is specifically the seed fixture's "N accounts
 * vouching only for each other" shape, length >= 3.
 *
 * The whole loop is disqualified (nobody in it counts as a ring member) the
 * moment ANY member has an active inbound vouch from a node OUTSIDE the loop
 * that is itself verified or trusted-standing. Real outside vindication
 * breaks the "closed loop with no outside trust" premise for the WHOLE
 * cluster, beyond the one vouched-for member.
 *
 * `isCandidate` picks the pool. It defaults to every unverified account. The
 * platform-wide trust assessment narrows it to unverified accounts that are
 * neither exempt (system, staff, founder) nor inactive (suspended or
 * deactivated).
 *
 * Returns one `Set` of node ids per ring. Tarjan's strongly-connected-
 * components algorithm, iterative so a long candidate chain on a
 * platform-wide graph cannot exhaust the call stack.
 */
export function detectRings(
  nodes: RingCandidateNode[],
  edges: RingCandidateEdge[],
  isCandidate: RingCandidatePredicate = isUnverifiedRingCandidate,
): Set<string>[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const candidateIds = new Set(
    nodes.filter((node) => isCandidate(node)).map((node) => node.id),
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

  const rings: Set<string>[] = [];
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
    rings.push(component);
  }
  return rings;
}

/**
 * The graph's per-node `inRing` flag: every node id in any ring, over the
 * original unverified candidate pool. Kept as a thin wrapper so `getGraph`
 * and its spec keep their exact behaviour.
 */
export function detectRingSlugs(
  nodes: RingCandidateNode[],
  edges: RingCandidateEdge[],
): Set<string> {
  const ringSlugs = new Set<string>();
  for (const ring of detectRings(nodes, edges)) {
    for (const memberId of ring) ringSlugs.add(memberId);
  }
  return ringSlugs;
}

/** One pending node on the explicit Tarjan call stack: the node and the
 *  position of the next out-neighbour to visit. */
interface TarjanFrame {
  nodeId: string;
  nextNeighborIndex: number;
}

/**
 * Tarjan's strongly-connected-components: every node id ends up in exactly
 * one returned `Set`. Runs on an explicit frame stack, so depth is bounded by
 * heap memory and a long chain of candidates is safe.
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

  function visit(nodeId: string, callStack: TarjanFrame[]): void {
    indexById.set(nodeId, nextIndex);
    lowlinkById.set(nodeId, nextIndex);
    nextIndex += 1;
    stack.push(nodeId);
    onStack.add(nodeId);
    callStack.push({ nodeId, nextNeighborIndex: 0 });
  }

  for (const startId of nodeIds) {
    if (indexById.has(startId)) continue;
    const callStack: TarjanFrame[] = [];
    visit(startId, callStack);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = outEdgesByNode.get(frame.nodeId) ?? [];

      if (frame.nextNeighborIndex < neighbors.length) {
        const neighborId = neighbors[frame.nextNeighborIndex]!;
        frame.nextNeighborIndex += 1;
        if (!indexById.has(neighborId)) {
          visit(neighborId, callStack);
        } else if (onStack.has(neighborId)) {
          lowlinkById.set(
            frame.nodeId,
            Math.min(
              lowlinkById.get(frame.nodeId)!,
              indexById.get(neighborId)!,
            ),
          );
        }
        continue;
      }

      // Every neighbour done: close the frame, emit a component when this
      // node is its root, then fold its lowlink into the caller's.
      callStack.pop();
      if (lowlinkById.get(frame.nodeId) === indexById.get(frame.nodeId)) {
        const component = new Set<string>();
        let memberId: string | undefined;
        do {
          memberId = stack.pop();
          if (memberId === undefined) break;
          onStack.delete(memberId);
          component.add(memberId);
        } while (memberId !== frame.nodeId);
        components.push(component);
      }
      const parentFrame = callStack[callStack.length - 1];
      if (parentFrame) {
        lowlinkById.set(
          parentFrame.nodeId,
          Math.min(
            lowlinkById.get(parentFrame.nodeId)!,
            lowlinkById.get(frame.nodeId)!,
          ),
        );
      }
    }
  }
  return components;
}
