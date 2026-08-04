import { IsUUID } from 'class-validator';

// Admin `POST /admin/roadmap/ideas/:id/merge` body — folds a pending idea
// into an existing item: moves its live votes onto `intoItemId`, sets that
// item's `requested: true`, and deletes the idea (see
// `RoadmapAdminService.mergeIdea`, Task A4).
export class MergeIdeaDto {
  @IsUUID()
  intoItemId!: string;
}
