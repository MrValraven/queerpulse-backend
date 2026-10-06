import { IsIn } from 'class-validator';
import { ASK_ENDED_REASONS } from '../forum-funding';
import type { AskEndedReason } from '../forum-funding';

// `POST /forum/threads/:slug/funding/end` body: the two things an author can
// say about their own fundraiser.
export class EndFundingAskDto {
  @IsIn(ASK_ENDED_REASONS)
  reason!: AskEndedReason;
}
