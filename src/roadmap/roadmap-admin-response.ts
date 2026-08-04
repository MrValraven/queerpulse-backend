import {
  RoadmapColumn,
  RoadmapConfidence,
  RoadmapCost,
  RoadmapGuide,
  RoadmapPaidKind,
  RoadmapPriority,
  RoadmapSafetyStatus,
  RoadmapSlipEntry,
  RoadmapItem,
} from './entities/roadmap-item.entity';
import {
  RoadmapDeclineReason,
  RoadmapIdea,
  RoadmapIdeaStatus,
} from './entities/roadmap-idea.entity';
import { RoadmapTeamMember } from './entities/roadmap-team-member.entity';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';
import type { HeroStat } from './entities/roadmap-settings.entity';

/**
 * Admin `/admin/roadmap` response shapes — unlike the public DTOs in
 * `roadmap-response.ts`, these expose the raw seed `votes` alongside
 * `liveVotes` (real member votes) so the admin UI can show both, plus
 * `sortOrder`/`column`/`status` for editing. `fromMember` is a derived
 * boolean (`submittedById !== null`) — the member id itself is never sent to
 * the client. Field names/shapes match the Appendix — Frozen Contract in
 * `queerpulse/docs/superpowers/plans/2026-08-04-admin-roadmap-redesign.md`
 * verbatim; `RoadmapItem`/`RoadmapIdea`'s own `RoadmapSlipEntry`/
 * `RoadmapGuide` jsonb-shape interfaces are reused directly here rather than
 * redeclared, since they already match the contract field-for-field.
 */

// One entry in an item's `voteBreakdown.top` — the communities its voters
// come from, most-represented first.
export interface AdminVoteBreakdownEntryDTO {
  communityName: string;
  count: number;
}

export interface AdminVoteBreakdownDTO {
  top: AdminVoteBreakdownEntryDTO[];
  // Voters not attributable to one of the `top` communities (no community,
  // or a long tail collapsed into one bucket).
  other: number;
}

// One row in an item's drawer Comments section.
export interface AdminItemCommentDTO {
  id: string;
  authorLabel: string;
  body: string;
  hidden: boolean;
  createdAt: string;
}

export interface AdminRoadmapItemDTO {
  id: string;
  column: RoadmapColumn;
  category: string;
  name: string;
  // Internal notes, not shown to members.
  description: string;
  // The warm one-liner shown on the public roadmap.
  publicNote: string | null;
  date: string | null;
  stage: string | null;
  eta: string | null;
  targetQuarter: string | null;
  progress: number | null;
  priority: RoadmapPriority;
  confidence: RoadmapConfidence;
  committed: boolean;
  isPublic: boolean;
  requested: boolean;
  notified: boolean;
  spikeFlag: boolean;
  safetyStatus: RoadmapSafetyStatus;
  blockedBy: string | null;
  blockedWhy: string | null;
  paidKind: RoadmapPaidKind;
  weeklyHours: number;
  cost: RoadmapCost;
  ownerId: string | null;
  // Resolved from `users` in one batch query per `GET /admin` call — see
  // `RoadmapItem.ownerId`'s doc.
  ownerName: string | null;
  slips: RoadmapSlipEntry[];
  guide: RoadmapGuide | null;
  // Outgoing "depends on" edges — other item ids.
  deps: string[];
  votes: number;
  liveVotes: number;
  voteBreakdown: AdminVoteBreakdownDTO;
  comments: AdminItemCommentDTO[];
  // Planned only — flags the "🔥 Hot" badge (also read by the public
  // planned-card mapper in `roadmap-response.ts`).
  hot: boolean;
  // Hidden from every view except the Archive view. Toggled only via the
  // dedicated `PATCH .../items/:id/archive` route (`ArchiveItemDto`), not the
  // general create/update body — see `create-roadmap-item.dto.ts`'s class
  // comment for the other fields that follow this same "own endpoint" split.
  archived: boolean;
  sortOrder: number;
  // `RoadmapItem.updatedAt` — the drawer/board label this "touched".
  updatedAt: string;
}

export interface AdminRoadmapIdeaDTO {
  id: string;
  text: string;
  status: RoadmapIdeaStatus;
  category: string;
  note: string | null;
  duplicateOfItemId: string | null;
  declineReason: RoadmapDeclineReason | null;
  declineNote: string | null;
  votes: number;
  liveVotes: number;
  fromMember: boolean;
  sortOrder: number;
  createdAt: string;
}

export interface RoadmapTeamMemberDTO {
  id: string;
  userId: string;
  // Resolved from `users` in one batch query, same as `ownerName` above —
  // never a raw relation load per row.
  name: string;
  role: string;
  weeklyCapHours: number;
  paid: boolean;
  sortOrder: number;
}

export interface RoadmapAuditEntryDTO {
  id: string;
  actorLabel: string;
  action: string;
  createdAt: string;
}

export interface RoadmapAdminResponse {
  items: AdminRoadmapItemDTO[];
  ideas: AdminRoadmapIdeaDTO[];
  team: RoadmapTeamMemberDTO[];
  audit: RoadmapAuditEntryDTO[];
  heroStats: HeroStat[];
}

// The computed/joined values `getAdmin()` (Task A4) resolves once per
// `GET /admin` call and passes in per item, rather than this mapper querying
// per row (would be an N+1 across `users`/`roadmap_votes`/
// `roadmap_item_comments`/`roadmap_item_dependencies`).
export interface AdminItemExtras {
  liveVotes: number;
  ownerName: string | null;
  voteBreakdown: AdminVoteBreakdownDTO;
  comments: AdminItemCommentDTO[];
  deps: string[];
}

export const toAdminItemDTO = (
  item: RoadmapItem,
  extras: AdminItemExtras,
): AdminRoadmapItemDTO => ({
  id: item.id,
  column: item.column,
  category: item.category,
  name: item.name,
  description: item.description,
  publicNote: item.publicNote,
  date: item.date,
  stage: item.stage,
  eta: item.eta,
  targetQuarter: item.targetQuarter,
  progress: item.progress,
  priority: item.priority,
  confidence: item.confidence,
  committed: item.committed,
  isPublic: item.isPublic,
  requested: item.requested,
  notified: item.notified,
  spikeFlag: item.spikeFlag,
  safetyStatus: item.safetyStatus,
  blockedBy: item.blockedBy,
  blockedWhy: item.blockedWhy,
  paidKind: item.paidKind,
  weeklyHours: item.weeklyHours,
  cost: item.cost,
  ownerId: item.ownerId,
  ownerName: extras.ownerName,
  slips: item.slips,
  guide: item.guide,
  deps: extras.deps,
  votes: item.votes,
  liveVotes: extras.liveVotes,
  voteBreakdown: extras.voteBreakdown,
  comments: extras.comments,
  hot: item.hot,
  archived: item.archived,
  sortOrder: item.sortOrder,
  updatedAt: item.updatedAt.toISOString(),
});

export const toAdminIdeaDTO = (
  idea: RoadmapIdea,
  liveVotes: number,
): AdminRoadmapIdeaDTO => ({
  id: idea.id,
  text: idea.text,
  status: idea.status,
  category: idea.category,
  note: idea.note,
  duplicateOfItemId: idea.duplicateOfItemId,
  declineReason: idea.declineReason,
  declineNote: idea.declineNote,
  votes: idea.votes,
  liveVotes,
  // Never leak `submittedById` to the client — only whether the idea came
  // from a member (vs. seeded with no attributed submitter).
  fromMember: idea.submittedById !== null,
  sortOrder: idea.sortOrder,
  createdAt: idea.createdAt.toISOString(),
});

export const toTeamMemberDTO = (
  member: RoadmapTeamMember,
  name: string,
): RoadmapTeamMemberDTO => ({
  id: member.id,
  userId: member.userId,
  name,
  role: member.role,
  weeklyCapHours: member.weeklyCapHours,
  paid: member.paid,
  sortOrder: member.sortOrder,
});

export const toAuditEntryDTO = (
  row: RoadmapAuditLog,
): RoadmapAuditEntryDTO => ({
  id: row.id,
  actorLabel: row.actorLabel,
  action: row.action,
  createdAt: row.createdAt.toISOString(),
});
