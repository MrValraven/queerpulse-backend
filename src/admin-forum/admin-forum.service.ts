import { Injectable } from '@nestjs/common';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumThreadResponse } from '../forum/forum-response';
import { ForumThreadsService } from '../forum/forum-threads.service';

/**
 * Admin-only surface for forum moderation actions beyond what
 * `ForumController` already exposes to authors/moderators. Currently just the
 * "QueerPulse Official" byline toggle; delegates the actual read/write to
 * `ForumThreadsService`, which owns the thread entity.
 */
@Injectable()
export class AdminForumService {
  constructor(private readonly threads: ForumThreadsService) {}

  setThreadOfficial(
    slug: string,
    user: CurrentUserData,
    isOfficial: boolean,
  ): Promise<ForumThreadResponse> {
    return this.threads.setOfficial(slug, user, isOfficial);
  }
}
