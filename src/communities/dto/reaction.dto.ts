import { IsIn } from 'class-validator';
import { ReactionKey } from '../entities/community-post-reaction.entity';

export class ReactionDto {
  @IsIn([
    ReactionKey.Heart,
    ReactionKey.Celebrate,
    ReactionKey.Support,
    ReactionKey.Fire,
  ])
  key: ReactionKey;
}
