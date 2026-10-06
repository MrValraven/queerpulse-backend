export const FORUM_THREAD_CREATED = 'forum.thread_created';

/**
 * A member started a new forum thread. Emitted once, when the thread first
 * becomes visible (at create for a thread published straight away, or on the
 * deferred fan-out for a scheduled or reviewed one), so a listener never
 * reacts to a thread a rolled-back transaction never created.
 *
 * Threads DO have a visibility dimension: a thread can belong to a gated
 * community or a space, and then only that roster can read it. The emitter
 * applies the gate so the event carries none (ENG-418): `runThreadFanOut` in
 * `ForumThreadsService` emits this only for a thread every active member can
 * read (no community, cross-posted, or a top-level live `public` community)
 * and only when the author is shown by name (neither anonymous nor posted as
 * QueerPulse Official). A listener may therefore treat every event it
 * receives as public.
 *
 * Consumed by the profiles `ActivityListener`, which records a public
 * "started a thread" activity row for the author's profile.
 */
export interface ForumThreadCreatedEvent {
  authorId: string;
  threadSlug: string;
  title: string;
}

export const FORUM_FUNDING_DEADLINE_CHANGED = 'forum.funding_deadline_changed';

/**
 * An open call's deadline moved. Emitted by
 * `ForumFundingService.emitDeadlineChanged` after the edit committed, so a
 * listener never reacts to a rolled-back write. Consumed by
 * `FundingDeadlineChangedListener` (P3), which tells the members who saved
 * the thread. Ids and the thread's own title only; no member-authored body.
 */
export interface ForumFundingDeadlineChangedEvent {
  threadId: string;
  threadSlug: string;
  threadTitle: string;
  /** The thread's author, or null once they erased their account. */
  authorId: string | null;
  /** Whoever made the edit (the author or a moderator). */
  editorId: string;
  /** ISO 8601, or null when the call became rolling. */
  deadline: string | null;
}
