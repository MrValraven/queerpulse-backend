/**
 * Response shapes of the live connections routes at `admin/vj/live` and the
 * pure builder that sorts them. Every object is a literal of its contract
 * fields; a connection is named by its socket id only, and an owner by the
 * profile name the admin member lists show.
 */
import type { VjRenderer } from './vj.contract';

export type VjLiveRole = 'screen' | 'remote';

export interface VjLiveConnectionDTO {
  /** The socket id. */
  connectionId: string;
  role: VjLiveRole;
  /** Screens only; null for a remote. */
  screenNumber: number | null;
  /** Screens only; false for a remote. */
  isLead: boolean;
  /** ISO. A screen's attach time, or the time a remote's attach landed. */
  connectedAt: string;
  /** A screen's last status report; null before the first one and for a remote. */
  isFullscreen: boolean | null;
  /** A screen's reported renderer; null before a valid health report and for a remote. */
  renderer: VjRenderer | null;
}

export interface VjLiveOwnerDTO {
  userId: string;
  /** `${firstName} ${lastName}`.trim() from profiles; empty when the profile is gone. */
  displayName: string;
}

export interface VjLiveStageDTO {
  owner: VjLiveOwnerDTO;
  isOwnStage: boolean;
  /** Screens by number, then remotes by `connectedAt`. */
  connections: VjLiveConnectionDTO[];
}

export interface VjLiveDTO {
  /** Stages with at least one attached connection: the caller's own first,
   *  then by owner name. */
  stages: VjLiveStageDTO[];
  /** Stages in scope held in memory with no attached connection. */
  idleStageCount: number;
}

export interface VjLiveStoppedDTO {
  stoppedScreenCount: number;
  stoppedRemoteCount: number;
}

/** One connected screen of a stage, as the gateway reads it. */
export interface VjLiveScreenSnapshot {
  connectionId: string;
  number: number;
  isLead: boolean;
  /** Epoch ms. */
  connectedAt: number;
  isFullscreen: boolean | null;
  renderer: VjRenderer | null;
}

/** One attached remote of a stage, as the gateway reads it. */
export interface VjLiveRemoteSnapshot {
  connectionId: string;
  /** Epoch ms. */
  connectedAt: number;
}

/** One stage with its live sockets, as the gateway reads it. */
export interface VjLiveStageSnapshot {
  ownerUserId: string;
  screens: VjLiveScreenSnapshot[];
  remotes: VjLiveRemoteSnapshot[];
}

function toScreenConnection(screen: VjLiveScreenSnapshot): VjLiveConnectionDTO {
  return {
    connectionId: screen.connectionId,
    role: 'screen',
    screenNumber: screen.number,
    isLead: screen.isLead,
    connectedAt: new Date(screen.connectedAt).toISOString(),
    isFullscreen: screen.isFullscreen,
    renderer: screen.renderer,
  };
}

function toRemoteConnection(remote: VjLiveRemoteSnapshot): VjLiveConnectionDTO {
  return {
    connectionId: remote.connectionId,
    role: 'remote',
    screenNumber: null,
    isLead: false,
    connectedAt: new Date(remote.connectedAt).toISOString(),
    isFullscreen: null,
    renderer: null,
  };
}

/**
 * The live connections answer: each stage with at least one connection, its
 * screens by number and then its remotes by attach time (socket id on a tie),
 * the caller's own stage first and the rest by owner name, then owner id.
 */
export function toVjLiveDTO(
  snapshots: readonly VjLiveStageSnapshot[],
  displayNames: ReadonlyMap<string, string>,
  callerUserId: string,
  idleStageCount: number,
): VjLiveDTO {
  const stages: VjLiveStageDTO[] = snapshots
    .filter((stage) => stage.screens.length + stage.remotes.length > 0)
    .map((stage) => {
      const screens = [...stage.screens].sort(
        (first, second) => first.number - second.number,
      );
      const remotes = [...stage.remotes].sort(
        (first, second) =>
          first.connectedAt - second.connectedAt ||
          first.connectionId.localeCompare(second.connectionId),
      );
      return {
        owner: {
          userId: stage.ownerUserId,
          displayName: displayNames.get(stage.ownerUserId) ?? '',
        },
        isOwnStage: stage.ownerUserId === callerUserId,
        connections: [
          ...screens.map(toScreenConnection),
          ...remotes.map(toRemoteConnection),
        ],
      };
    });
  stages.sort(
    (first, second) =>
      Number(second.isOwnStage) - Number(first.isOwnStage) ||
      first.owner.displayName.localeCompare(second.owner.displayName) ||
      first.owner.userId.localeCompare(second.owner.userId),
  );
  return { stages, idleStageCount };
}
