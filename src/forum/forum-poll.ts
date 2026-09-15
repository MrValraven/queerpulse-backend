import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import {
  CreateThreadPollDto,
  MAX_POLL_OPTIONS,
  MIN_POLL_OPTIONS,
} from './dto/create-thread-poll.dto';
import { ForumPollOption } from './entities/forum-poll-option.entity';
import { ForumPollVote } from './entities/forum-poll-vote.entity';
import { ForumPoll } from './entities/forum-poll.entity';
import { ForumPollOptionView, ForumPollView } from './forum-response';

/**
 * The poll half of a create request, after validation and normalization and
 * before anything is inserted.
 *
 * Separate from `CreateThreadPollDto` for the same reason `ResolvedThreadFields`
 * is separate from `CreateThreadInput`: these are not what the caller sent. The
 * labels are trimmed and proven distinct, and `closesAt` is a parsed `Date` that
 * has already been held to the schedule window. `createWithUniqueSlug` can
 * therefore write this straight out without remembering which parts of the DTO
 * it may trust.
 *
 * THIS FILE HAS NO SERVICE DEPENDENCIES ON PURPOSE. `ForumThreadsService` needs
 * the write half, `ForumPollsService` needs the write validation AND the read
 * half, and `ForumPollsService` already depends on `ForumThreadsService` for the
 * visibility gate. Putting the shared pieces in a plain module keeps that a
 * one-way arrow instead of the `forwardRef` cycle it would otherwise be.
 */
export interface ResolvedPollInput {
  labels: string[];
  allowMultiple: boolean;
  closesAt: Date | null;
}

/**
 * Trims the option labels and refuses a poll whose options are not distinct.
 *
 * DUPLICATES ARE A 400, not a silent dedupe. `normalizeTags` drops a repeated
 * tag because a tag is a filter key and a member typing one twice meant it once;
 * a poll option is a CHOICE, and quietly collapsing six options into five leaves
 * the author with a ballot they did not write and voters picking between
 * positions that shifted underneath them. The comparison is case- and
 * whitespace-insensitive, because `'Yes'` next to `'yes '` is two bars a reader
 * cannot tell apart, which is the failure the rule exists to prevent rather
 * than a string-equality technicality.
 *
 * The count is re-checked here as well as on the DTO, the way
 * `normalizePostPhotos` re-applies its cap: this is the function that decides
 * what gets written, and it must hold even for a caller that reached the service
 * another way.
 */
export function resolvePollLabels(poll: CreateThreadPollDto): string[] {
  const labels = poll.options.map((option) => option.label.trim());
  if (labels.some((label) => !label)) {
    throw new BadRequestException('Every poll option needs a label');
  }
  if (labels.length < MIN_POLL_OPTIONS || labels.length > MAX_POLL_OPTIONS) {
    throw new BadRequestException(
      `A poll needs between ${MIN_POLL_OPTIONS} and ${MAX_POLL_OPTIONS} options`,
    );
  }
  const seen = new Set<string>();
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) {
      throw new BadRequestException('Poll options must be different');
    }
    seen.add(key);
  }
  return labels;
}

/**
 * Writes the poll and its options, in label order, `position` 0..n-1.
 *
 * Takes an `EntityManager` because the only caller is inside the thread's own
 * create transaction and must stay there: the whole point of creating the poll
 * alongside the thread and the opening post is that a thread can never exist
 * carrying half a ballot. A poll whose options failed to insert would render as
 * a question with nothing to pick, and the `UNIQUE (thread_id)` on `forum_poll`
 * means a retry could not simply add them.
 *
 * `vote_count` is left to the column default of 0 rather than named here — a
 * brand-new option has no votes, and this is the one moment where the default
 * is unambiguously the truth.
 */
export async function insertThreadPoll(
  manager: EntityManager,
  threadId: string,
  resolved: ResolvedPollInput,
): Promise<ForumPoll> {
  const poll = await manager.save(
    manager.create(ForumPoll, {
      threadId,
      allowMultiple: resolved.allowMultiple,
      closesAt: resolved.closesAt,
    }),
  );
  await manager.save(
    resolved.labels.map((label, position) =>
      manager.create(ForumPollOption, {
        pollId: poll.id,
        label,
        position,
      }),
    ),
  );
  return poll;
}

/**
 * Whether voting has shut. Derived on read, never stored and never scheduled:
 * a timestamp compared at the moment somebody asks cannot drift, cannot fire
 * twice and needs no job — the same call `ForumThread.closesAt` makes.
 *
 * A CLOSED POLL STILL READS. Closing stops the write path (`ForumPollsService
 * .vote` refuses), and it is one of the three things that RELEASE the results
 * (see `toPollView`). It never hides the poll.
 */
export function isPollClosed(
  poll: Pick<ForumPoll, 'closesAt'>,
  now: number = Date.now(),
): boolean {
  return poll.closesAt !== null && poll.closesAt.getTime() <= now;
}

/**
 * THE results-visibility rule, in one place so the page mapper, the single
 * -thread echoes and the vote response cannot drift apart.
 *
 * Released when the caller has voted, when the poll has closed, or to a platform
 * moderator. `ForumPollView`'s docstring carries the reasoning for each arm and
 * for why this is enforced on the server at all rather than left to the client.
 */
function areResultsVisible(
  poll: Pick<ForumPoll, 'closesAt'>,
  hasVoted: boolean,
  viewerIsModerator: boolean,
): boolean {
  return hasVoted || isPollClosed(poll) || viewerIsModerator;
}

/**
 * Builds one poll's response shape for one viewer.
 *
 * `options` must already be ordered by `position`; every read path here gets
 * that ordering out of `UQ_forum_poll_option_poll_position` for free.
 *
 * When the results are withheld the counts are NULL rather than zero, and that
 * distinction is the whole contract: zero is a real answer ("nobody has picked
 * this yet") that a caller entitled to the count receives, while null is the
 * server declining to say. A client that rendered a withheld poll as a row of
 * empty bars would be publishing a number it was not given.
 */
export function toPollView(
  poll: ForumPoll,
  options: ForumPollOption[],
  myOptionIds: Set<string>,
  viewerIsModerator: boolean,
): ForumPollView {
  const hasVoted = myOptionIds.size > 0;
  const resultsVisible = areResultsVisible(poll, hasVoted, viewerIsModerator);
  const optionViews: ForumPollOptionView[] = options.map((option) => ({
    id: option.id,
    label: option.label,
    position: option.position,
    voteCount: resultsVisible ? option.voteCount : null,
    // Never withheld: this is the caller's own ballot, and hiding it from them
    // would mean a member could not tell whether their vote had registered.
    selected: myOptionIds.has(option.id),
  }));
  return {
    id: poll.id,
    allowMultiple: poll.allowMultiple,
    options: optionViews,
    totalVotes: resultsVisible
      ? options.reduce((total, option) => total + option.voteCount, 0)
      : null,
    closesAt: poll.closesAt ? poll.closesAt.toISOString() : null,
    isClosed: isPollClosed(poll),
    hasVoted,
    resultsVisible,
  };
}

/**
 * Every listed thread's poll, for one viewer, in THREE queries regardless of
 * how many threads are on the page: the polls, their options, and the viewer's
 * own ballots across all of them.
 *
 * This is the same batching shape `MemberLookup` uses for authors and
 * `unreadReplyCountsByThread` uses for the unread badge, and it is why both the
 * page mapper (`ForumThreadsService.toThreadResponses`) and the single-thread
 * echoes (`resolveOp`, and through it `getBySlug`) call THIS rather than each
 * growing a poll lookup of their own. A per-thread poll read would be three
 * queries per row on a twenty-row page.
 *
 * Every `IN` here rides an index that already exists, so no migration is owed:
 * `UQ_forum_poll_thread_id` serves the poll lookup, the leading `poll_id` of
 * `UQ_forum_poll_option_poll_position` serves the options (and returns them
 * already ordered), and `IDX_forum_poll_vote_poll_id` serves the ballots.
 *
 * A NEUTRAL VIEWER (empty `viewerId`, as `listRecentByCommunity` passes) skips
 * the ballot query entirely and sees a poll with no selection and — since
 * nobody has voted as nobody — withheld results unless the poll has closed.
 * That is the correct answer for a card rendered without anybody in particular
 * looking at it.
 */
export async function pollViewsByThread(
  manager: EntityManager,
  threadIds: string[],
  viewerId: string,
  viewerIsModerator: boolean,
): Promise<Map<string, ForumPollView>> {
  const byThread = new Map<string, ForumPollView>();
  if (!threadIds.length) return byThread;

  const polls = await manager.find(ForumPoll, {
    where: { threadId: In(threadIds) },
  });
  if (!polls.length) return byThread;

  const pollIds = polls.map((poll) => poll.id);
  const [options, myVotes] = await Promise.all([
    manager.find(ForumPollOption, {
      where: { pollId: In(pollIds) },
      order: { pollId: 'ASC', position: 'ASC' },
    }),
    viewerId
      ? manager.find(ForumPollVote, {
          where: { pollId: In(pollIds), userId: viewerId },
        })
      : Promise.resolve<ForumPollVote[]>([]),
  ]);

  const optionsByPoll = new Map<string, ForumPollOption[]>();
  for (const option of options) {
    const existing = optionsByPoll.get(option.pollId);
    if (existing) {
      existing.push(option);
    } else {
      optionsByPoll.set(option.pollId, [option]);
    }
  }
  const myOptionIds = new Set(myVotes.map((vote) => vote.optionId));

  for (const poll of polls) {
    byThread.set(
      poll.threadId,
      toPollView(
        poll,
        optionsByPoll.get(poll.id) ?? [],
        // Scoped to THIS poll's options, so a member's ballot in one poll can
        // never mark an option in another as selected.
        new Set(
          (optionsByPoll.get(poll.id) ?? [])
            .filter((option) => myOptionIds.has(option.id))
            .map((option) => option.id),
        ),
        viewerIsModerator,
      ),
    );
  }
  return byThread;
}
