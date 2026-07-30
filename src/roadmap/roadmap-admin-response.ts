import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapIdea, RoadmapIdeaStatus } from './entities/roadmap-idea.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';

/**
 * Admin `/admin/roadmap` response shapes — unlike the public DTOs in
 * `roadmap-response.ts`, these expose the raw seed `votes` alongside
 * `liveVotes` (real member votes) so the admin UI can show both, plus
 * `sortOrder`/`column`/`status` for editing. `fromMember` is a derived
 * boolean (`submittedById !== null`) — the member id itself is never sent to
 * the client.
 */

export interface AdminRoadmapItemDTO {
  id: string;
  column: string;
  category: string;
  name: string;
  description: string;
  date: string | null;
  stage: string | null;
  eta: string | null;
  progress: number | null;
  votes: number;
  liveVotes: number;
  requested: boolean;
  hot: boolean;
  sortOrder: number;
}

export interface AdminRoadmapIdeaDTO {
  id: string;
  text: string;
  status: RoadmapIdeaStatus;
  votes: number;
  liveVotes: number;
  fromMember: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface RoadmapAdminResponse {
  items: AdminRoadmapItemDTO[];
  ideas: AdminRoadmapIdeaDTO[];
  heroStats: HeroStat[];
}

export const toAdminItemDTO = (
  item: RoadmapItem,
  liveVotes: number,
): AdminRoadmapItemDTO => ({
  id: item.id,
  column: item.column,
  category: item.category,
  name: item.name,
  description: item.description,
  date: item.date,
  stage: item.stage,
  eta: item.eta,
  progress: item.progress,
  votes: item.votes,
  liveVotes,
  requested: item.requested,
  hot: item.hot,
  sortOrder: item.sortOrder,
});

export const toAdminIdeaDTO = (
  idea: RoadmapIdea,
  liveVotes: number,
): AdminRoadmapIdeaDTO => ({
  id: idea.id,
  text: idea.text,
  status: idea.status,
  votes: idea.votes,
  liveVotes,
  // Never leak `submittedById` to the client — only whether the idea came
  // from a member (vs. seeded with no attributed submitter).
  fromMember: idea.submittedById !== null,
  sortOrder: idea.sortOrder,
  createdAt: idea.createdAt.toISOString(),
});
