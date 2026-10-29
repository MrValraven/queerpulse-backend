import { IsEnum, IsUUID } from 'class-validator';
import { RoadmapVoteTarget } from '../entities/roadmap-vote.entity';

// Member `DELETE /roadmap/vote/:targetType/:targetId` path params, taking back
// the caller's own vote for a planned item or a published idea. Idempotent:
// removing a vote that does not exist is a no-op (see
// `RoadmapService.removeVote`).
export class RemoveVoteDto {
  @IsEnum(RoadmapVoteTarget)
  targetType!: RoadmapVoteTarget;

  @IsUUID()
  targetId!: string;
}
