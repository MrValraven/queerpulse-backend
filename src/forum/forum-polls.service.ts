import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ForumPollOption } from './entities/forum-poll-option.entity';
import { ForumPollVote } from './entities/forum-poll-vote.entity';
import { ForumPoll } from './entities/forum-poll.entity';
import { isPollClosed, toPollView } from './forum-poll';
import { ForumPollView } from './forum-response';
import { ForumThreadsService, isModeratorRole } from './forum-threads.service';

@Injectable()
export class ForumPollsService {
  constructor(
    @InjectRepository(ForumPoll)
    private readonly polls: Repository<ForumPoll>,
    @InjectRepository(ForumPollOption)
    private readonly options: Repository<ForumPollOption>,
    // One-way: this service reaches for the thread gate, and nothing in
    // `ForumThreadsService` reaches back here (it writes polls through the
    // plain helpers in `forum-poll.ts`). That is what keeps the module free of
    // a `forwardRef`. Same arrangement `ForumPostsService` already has.
    private readonly threadsService: ForumThreadsService,
  ) {}

  /**
   * POST /forum/threads/:slug/poll/vote: cast a ballot.
   *
   * ## What is enforced, and where each rule comes from
   *
   * 1. THE THREAD MUST BE VISIBLE TO THE CALLER. Delegated to
   *    `ForumThreadsService.loadOr404`, the same helper every forum read and
   *    write already goes through, so a withdrawn thread, a blocked author's
   *    thread, a gated community's thread read from off the roster and a
   *    scheduled or under-review thread all 404 here exactly as they do
   *    everywhere else. This deliberately does NOT restate the predicate: a
   *    third spelling of the visibility rule is a third thing to keep in step,
   *    and the forum has already paid for that once (see
   *    `forumThreadVisibleSql`).
   * 2. A COMMUNITY THREAD TAKES VOTES FROM ITS ROSTER. `assertCanReplyInThread`,
   *    for the same reason replying uses it: on the `public` tier a
   *    community's thread is readable platform-wide but writable only by
   *    members, and a poll vote is a write into that thread. The same gate
   *    also 404s a member who is not staff once the community is taken down.
   * 3. THE POLL MUST BE OPEN. `closesAt` is checked at write time, on every
   *    vote. A closed poll still READS: closing stops voting, and viewing
   *    stays open.
   * 4. ARITY. A single-choice poll takes exactly one option; a multi-choice poll
   *    takes one to all of them. The DTO caps the array, but only this service
   *    knows `allowMultiple`, so the "exactly one" half lives here.
   * 5. EVERY OPTION MUST BELONG TO THIS POLL. Checked against the poll's own
   *    option ids. Trusting the FK alone would happily accept an option from
   *    somebody else's poll and record a vote nothing renders.
   *
   * DELIBERATELY NOT ENFORCED: the thread's `isLocked` and its own `closesAt`.
   * `ForumPoll.closesAt` is documented as independent of the thread's: a
   * thread can keep taking replies after its poll shuts, and a poll can close
   * first. Coupling the two here would quietly give a moderator's lock and
   * an author's reply deadline a second meaning neither of them was given.
   *
   * ## Re-voting replaces, it does not stack
   *
   * The request carries the caller's COMPLETE selection, so the write is a
   * reconciliation: ballots they hold that are not in the new set are deleted,
   * ballots in the new set they do not hold are inserted, and the ones on both
   * sides are left alone, which is what keeps sending the same array twice a
   * no-op with no double count.
   *
   * `vote_count` is kept in step with the vote rows the way
   * `ForumPostsService.vote` already solves the identical problem for
   * `forum_post_vote`: the counter moves ONLY when the statement that moved the
   * rows reports it did. A delete decrements only when `affected` is positive;
   * an insert is `orIgnore` and increments only when a row actually came back
   * from `RETURNING`, so a re-vote that loses the race against the unique
   * `(option_id, user_id)` adds nothing. Both, and the read-back, are one
   * transaction, so no other request can observe a count that disagrees with
   * the ballots behind it.
   *
   * The loops run at most `MAX_POLL_OPTIONS` times each (six), which is why
   * they stay loops: per-row `affected` is what makes the counter provably
   * correct, and six statements inside one transaction is not a cost worth
   * trading for a single clever statement with `RETURNING` fanned back out.
   */
  async vote(
    slug: string,
    user: CurrentUserData,
    optionIds: string[],
  ): Promise<ForumPollView> {
    const viewerIsModerator = isModeratorRole(user.role);
    const thread = await this.threadsService.loadOr404(slug, user.userId, {
      includeUnpublished: viewerIsModerator,
    });
    await this.threadsService.assertCanReplyInThread(thread, user.userId);

    const poll = await this.polls.findOne({ where: { threadId: thread.id } });
    if (!poll) {
      throw new NotFoundException('This thread has no poll');
    }
    if (isPollClosed(poll)) {
      throw new ForbiddenException('This poll has closed');
    }

    // Deduped: a client that names the same option twice has still expressed
    // one unambiguous choice, so the request goes through (see `VotePollDto`).
    const requested = [...new Set(optionIds)];
    // Validated OUTSIDE the transaction, exactly as `ForumPostsService.vote`
    // authorizes outside its own: these are reads that touch none of the rows
    // the write locks, and holding a write transaction open across them would
    // widen the window in which two concurrent ballots contend for nothing.
    const options = await this.options.find({
      where: { pollId: poll.id },
      order: { position: 'ASC' },
    });
    const optionIdsInPoll = new Set(options.map((option) => option.id));
    for (const optionId of requested) {
      if (!optionIdsInPoll.has(optionId)) {
        // An option id that is not in this poll returns 404: it is either
        // another poll's option or nothing at all, and a 404 keeps a caller
        // from learning which one they guessed.
        throw new NotFoundException('That option is not on this poll');
      }
    }
    if (!poll.allowMultiple && requested.length !== 1) {
      throw new BadRequestException('This poll takes exactly one answer');
    }
    if (!requested.length) {
      throw new BadRequestException('Pick at least one option');
    }

    return this.polls.manager.transaction(async (manager) => {
      // Serialize per member per poll before reading any ballot. The unique
      // constraint that guards a ballot lives on `(option_id, user_id)`, so it
      // only ever sees one option at a time. A single-choice re-vote moves
      // from one option to another, so two concurrent calls from the same
      // member, `vote(['a'])` racing `vote(['b'])`, each target a different
      // option and each pass that constraint cleanly: both read "no existing
      // ballot" for their own option, both insert, and the member ends up
      // double-counted with a live ballot on both options in what is supposed
      // to be a single-choice poll. The advisory lock is keyed on the member
      // and the poll, which is what makes it apply across every option the
      // poll has, and it serializes the whole read-then-write section so the
      // second call always sees the first call's committed ballot. The
      // precedent is `subprofiles/subprofile-creator-transfer.ts:109`.
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `forum_poll_vote:${poll.id}:${user.userId}`,
      ]);

      const existing = await manager.find(ForumPollVote, {
        where: { pollId: poll.id, userId: user.userId },
      });
      const desired = new Set(requested);

      // Withdraw the picks that are not in the new selection. Deleted by row
      // ID so the `affected` count answers for exactly one option, which is
      // what lets the decrement below be exact under a concurrent re-vote:
      // the request that loses the race deletes nothing and decrements
      // nothing.
      for (const vote of existing) {
        if (desired.has(vote.optionId)) continue;
        const deleted = await manager.delete(ForumPollVote, { id: vote.id });
        if (deleted.affected && deleted.affected > 0) {
          await manager.decrement(
            ForumPollOption,
            { id: vote.optionId },
            'voteCount',
            1,
          );
        }
      }

      // Add the picks they did not already hold. `orIgnore` makes each insert
      // idempotent against `UQ_forum_poll_vote_option_user`, and the count only
      // moves when a row actually came back, the same insert-or-nothing shape
      // `ForumPostsService.vote` uses.
      const held = new Set(existing.map((vote) => vote.optionId));
      for (const optionId of requested) {
        if (held.has(optionId)) continue;
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(ForumPollVote)
          .values({ pollId: poll.id, optionId, userId: user.userId })
          .orIgnore()
          .execute();
        const insertedRows = inserted.raw as unknown[];
        if (insertedRows.length > 0) {
          await manager.increment(
            ForumPollOption,
            { id: optionId },
            'voteCount',
            1,
          );
        }
      }

      // Re-read inside the transaction so the counts returned reflect this
      // ballot and every other one committed before our row locks.
      const refreshed = await manager.find(ForumPollOption, {
        where: { pollId: poll.id },
        order: { position: 'ASC' },
      });
      // The caller has just voted, so the results are theirs to see. That is
      // the whole point of `resultsVisible` and why the vote response is the
      // first place most members ever see a count.
      return toPollView(poll, refreshed, desired, viewerIsModerator);
    });
  }
}
