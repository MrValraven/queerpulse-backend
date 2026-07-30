import { IsEnum, IsUUID } from 'class-validator';
import { RoadmapVoteTarget } from '../entities/roadmap-vote.entity';

// Member `POST /roadmap/votes` body — one vote for a planned item or a
// published idea. Idempotent: voting twice for the same target is a no-op,
// not an error (see `RoadmapService.castVote`).
export class CastVoteDto {
  @IsEnum(RoadmapVoteTarget)
  targetType: RoadmapVoteTarget;

  @IsUUID()
  targetId: string;
}
