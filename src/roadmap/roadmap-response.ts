import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapIdea } from './entities/roadmap-idea.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';

/**
 * Public `GET /roadmap` response shapes, hand-mapped from `RoadmapItem` /
 * `RoadmapIdea` / `HeroStat` — no global serializer, so every field here is
 * an explicit pick (never the raw entity), matching
 * `governance-finance-response.ts`. Mirrors the frontend's
 * `ShippedItem`/`BuildingItem`/`PlannedItem`/`HeroStat` shapes in
 * `queerpulse/src/features/marketing/roadmap.data.ts`.
 */

export interface HeroStatDTO {
  label: string;
  jade: boolean;
}

export interface ShippedItemDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  date: string | null;
  requested: boolean;
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
}

export interface PlannedItemDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  votes: number;
  hot: boolean;
}

export interface TopIdeaDTO {
  id: string;
  text: string;
  votes: number;
}

export interface RoadmapResponse {
  heroStats: HeroStatDTO[];
  shipped: ShippedItemDTO[];
  building: BuildingItemDTO[];
  planned: PlannedItemDTO[];
  topIdeas: TopIdeaDTO[];
}

export const toHeroStatDTO = (stat: HeroStat): HeroStatDTO => ({
  label: stat.label,
  jade: stat.jade ?? false,
});

export const toShippedDTO = (item: RoadmapItem): ShippedItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  description: item.description,
  date: item.date,
  requested: item.requested,
});

export const toBuildingDTO = (item: RoadmapItem): BuildingItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  description: item.description,
  stage: item.stage,
  eta: item.eta,
  progress: item.progress ?? 0,
  requested: item.requested,
});

// `liveVotes` is the count of `roadmap_votes` rows for this item — the
// displayed total is the seed `votes` column plus that live count.
export const toPlannedDTO = (item: RoadmapItem, liveVotes: number): PlannedItemDTO => ({
  id: item.id,
  category: item.category,
  name: item.name,
  description: item.description,
  votes: item.votes + liveVotes,
  hot: item.hot,
});

export const toTopIdeaDTO = (idea: RoadmapIdea, liveVotes: number): TopIdeaDTO => ({
  id: idea.id,
  text: idea.text,
  votes: idea.votes + liveVotes,
});
