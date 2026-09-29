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
