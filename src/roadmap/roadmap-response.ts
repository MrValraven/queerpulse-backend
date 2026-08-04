import { RoadmapItem } from './entities/roadmap-item.entity';
import {
  RoadmapIdea,
  RoadmapDeclineReason,
} from './entities/roadmap-idea.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';

/**
 * Public `GET /roadmap` response shapes, hand-mapped from `RoadmapItem` /
 * `RoadmapIdea` / `HeroStat` — no global serializer, so every field here is
 * an explicit pick (never the raw entity), matching
 * `governance-finance-response.ts`. Mirrors the frontend's
 * `ShippedItem`/`BuildingItem`/`PlannedItem`/`HeroStat`/`NotBuildingItem`
 * shapes in `queerpulse/src/features/marketing/roadmap.data.ts`.
 *
 * Deliberately public-safe: `committed`/`latestSlip` surface only the
 * one-liner reason a target date moved (never `movedByName`/`movedAt`), and
 * `notBuilding` surfaces only the member-facing `declineReason`/`declineNote`
 * — never the item's internal `description`, `ownerId`, `blockedWhy`, admin
 * `note`, audit trail, or comments.
 */

export interface HeroStatDTO {
  label: string;
  value?: string;
  note?: string;
  jade: boolean;
}

/** The most recent target-date move for a committed card — reason only, no
 *  who/when (those stay admin-only, see `RoadmapSlipEntry` on the entity). */
export interface SlipDTO {
  from: string;
  to: string;
  reason: string;
}

export interface ShippedItemDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  date: string | null;
  requested: boolean;
  committed: boolean;
  latestSlip: SlipDTO | null;
}

export interface BuildingItemDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  stage: string | null;
  eta: string | null;
  progress: number;
  requested: boolean;
  committed: boolean;
  latestSlip: SlipDTO | null;
}

export interface PlannedItemDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  votes: number;
  hot: boolean;
  committed: boolean;
  latestSlip: SlipDTO | null;
}

export interface TopIdeaDTO {
  id: string;
  text: string;
  votes: number;
}

/** A dismissed idea whose decline reason is member-facing — "Not building
 *  this, and why" on the public page. */
export interface NotBuildingDTO {
  id: string;
  category: string;
  reason: RoadmapDeclineReason;
  note: string;
  votes: number;
}

export interface RoadmapResponse {
  heroStats: HeroStatDTO[];
  shipped: ShippedItemDTO[];
  building: BuildingItemDTO[];
  planned: PlannedItemDTO[];
  /** "Someday" — public backlog-column items, same shape as `planned`. */
  backlog: PlannedItemDTO[];
  topIdeas: TopIdeaDTO[];
  notBuilding: NotBuildingDTO[];
}

export const toHeroStatDTO = (stat: HeroStat): HeroStatDTO => ({
  label: stat.label,
  value: stat.value,
  note: stat.note,
  jade: stat.jade ?? false,
});

// Last entry of `item.slips`, reason only — see the file doc for why
// `movedByName`/`movedAt` never leave this function.
const toLatestSlipDTO = (item: RoadmapItem): SlipDTO | null => {
  const last = item.slips[item.slips.length - 1];
  if (!last) return null;
  return { from: last.from, to: last.to, reason: last.reason };
};

export const toShippedDTO = (item: RoadmapItem): ShippedItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  // `item.description` is internal admin notes — never shown to members.
  // `publicNote` is the warm one-liner this DTO must render instead.
  description: item.publicNote ?? '',
  date: item.date,
  requested: item.requested,
  committed: item.committed,
  latestSlip: toLatestSlipDTO(item),
});

export const toBuildingDTO = (item: RoadmapItem): BuildingItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  // See `toShippedDTO` — `description` is internal; `publicNote` is public.
  description: item.publicNote ?? '',
  stage: item.stage,
  eta: item.eta,
  progress: item.progress ?? 0,
  requested: item.requested,
  committed: item.committed,
  latestSlip: toLatestSlipDTO(item),
});

// `liveVotes` is the count of `roadmap_votes` rows for this item — the
// displayed total is the seed `votes` column plus that live count. Also
// used for `backlog` items (planned/backlog share this exact shape).
export const toPlannedDTO = (
  item: RoadmapItem,
  liveVotes: number,
): PlannedItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  // See `toShippedDTO` — `description` is internal; `publicNote` is public.
  description: item.publicNote ?? '',
  votes: item.votes + liveVotes,
  hot: item.hot,
  committed: item.committed,
  latestSlip: toLatestSlipDTO(item),
});

export const toTopIdeaDTO = (
  idea: RoadmapIdea,
  liveVotes: number,
): TopIdeaDTO => ({
  id: idea.id,
  text: idea.text,
  votes: idea.votes + liveVotes,
});

// `idea.declineReason` is guaranteed non-null by the caller's query filter
// (`status = 'dismissed' AND declineReason IS NOT NULL`).
export const toNotBuildingDTO = (
  idea: RoadmapIdea,
  liveVotes: number,
): NotBuildingDTO => ({
  id: idea.id,
  category: idea.category,
  reason: idea.declineReason as RoadmapDeclineReason,
  note: idea.declineNote ?? '',
  votes: idea.votes + liveVotes,
});
