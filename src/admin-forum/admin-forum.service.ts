import { Injectable } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CursorPage } from '../common/cursor-pagination';
import { ForumThreadResponse } from '../forum/forum-response';
import { ForumThreadsService } from '../forum/forum-threads.service';
import { ReviewThreadDto } from './dto/review-thread.dto';

/**
 * Staff surface for forum moderation actions beyond what `ForumController`
 * already exposes to authors and moderators: the pre-publish review queue and
 * its verdicts, plus the "QueerPulse Official" byline toggle.
 *
 * Every method delegates to `ForumThreadsService`, which owns the thread entity
 * and the whole publish/review lifecycle behind it. Nothing here re-derives a
 * visibility rule or writes a thread column directly, deliberately: a second
 * place that knows when a thread is visible is a second place that can fall
 * behind the gate, which is the exact failure `SavedAvailabilityService` had.
 */
@Injectable()
export class AdminForumService {
  constructor(private readonly threads: ForumThreadsService) {}

  listReviewQueue(
    user: CurrentUserData,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumThreadResponse>> {
    return this.threads.listPendingReview(user, cursor, limit);
  }

  reviewThread(
    slug: string,
    user: CurrentUserData,
    dto: ReviewThreadDto,
  ): Promise<ForumThreadResponse> {
    // The DTO's verb is translated to a boolean here rather than passed down as
    // a string: the service writes `review_state`, and handing it the caller's
    // word would invite a third vocabulary between the two.
    return this.threads.reviewThread(
      slug,
      user,
      dto.decision === 'approve',
      dto.note,
    );
  }

  setThreadOfficial(
    slug: string,
    user: CurrentUserData,
    isOfficial: boolean,
  ): Promise<ForumThreadResponse> {
    return this.threads.setOfficial(slug, user, isOfficial);
  }
}
