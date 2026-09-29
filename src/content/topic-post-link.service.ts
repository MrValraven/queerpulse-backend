import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Profile } from '../users/entities/profile.entity';
import { TopicPost } from './entities/topic-post.entity';
import { Topic } from './entities/topic.entity';
import {
  TOPIC_POST_MASKED_BYLINES,
  TopicPostMaskedByline,
  topicPostAuthorMaskFor,
} from './topic-post-response';
import { TOPIC_POST_LINKED, TopicPostLinkedEvent } from './topic.events';

/** The `AvatarTint` palette `topic_post.author_tone` renders through
 *  (`TopicPost.authorTone`'s docstring). It mirrors the frontend's
 *  `tintForSlug` (`queerpulse/src/shared/api/refs.ts`) hash-and-mod algorithm
 *  exactly, so the tone assigned here is the SAME one that surface would
 *  compute for the same slug. */
const AVATAR_TONES = ['coral', 'plum', 'jade'] as const;

function toneForSlug(slug: string): (typeof AVATAR_TONES)[number] {
  let hash = 0;
  for (let index = 0; index < slug.length; index += 1) {
    hash = (hash * 31 + slug.charCodeAt(index)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function initialsFor(firstName: string, lastName: string): string {
  return `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
}

const EXCERPT_LIMIT = 200;

/**
 * The byline a topic post carries once the thread's author has erased their
 * account (ENG-494). The name matches `forum-response.ts`'s `UNKNOWN_AUTHOR`
 * ("Member"), so the thread reads the same on its topic page as in the forum.
 * The initials are the "M" the forum's own placeholder avatar shows for that
 * name. The tone is the frontend Avatar's neutral `default` tint: `QP` on
 * `plum` is the official QueerPulse byline (`TOPIC_POST_MASKED_BYLINES`), and
 * a thread whose author left must never read as written by the platform.
 * There is no slug left to hash, so the tone is fixed. Shared by the write
 * side (`memberByline`), the erasure scrub (`ContentOwnerErasureService`) and
 * the read side (`TopicsService.listPosts`).
 */
export const ERASED_AUTHOR_TOPIC_BYLINE: TopicPostMaskedByline = {
  authorName: 'Member',
  authorInitials: 'M',
  authorTone: 'default',
};

/**
 * DISC-5: reconciles forum thread tags against the curated `topics`
 * directory. `topic-post.entity.ts`'s docstring explains why `topic_post` is
 * a dedicated, WRITE-time-materialized table over a read-time aggregation of
 * `forum_thread`/`community_post`/`event`; this service is the write side
 * that had never existed. A thread's tags and the topics directory were
 * previously entirely disconnected, exactly the gap that docstring named.
 *
 * SCOPE: only forum thread CREATION is reconciled (`linkThread`, called once
 * from `ForumThreadsService.create`). A tag added to an existing thread
 * afterwards (`ForumThreadsService.updateThreadTitle`) is not retroactively
 * linked. That is a documented gap, the same posture `topics.adapters.tsx`
 * already takes for `topVoices`/the curated `resources` panel; the larger
 * relink/unlink-on-every-edit problem is out of this service's scope.
 *
 * MATCHING STRATEGY: exact, case-insensitive tag equality, with no
 * slugify/fuzzy reconciliation needed. Both sides are already normalized to
 * the same shape: `ForumThreadsService.normalizeTags` lowercases and strips a
 * leading `#` before a thread's tags are ever persisted, and `Topic.tag` is
 * seeded in that same lowercase, no-hash form (`healthcare`, `trans`, ...),
 * so a plain `IN (...)` lookup against `thread.tags` is sufficient.
 *
 * BYLINE: an anonymous or official thread is stored under its masked byline
 * (`TOPIC_POST_MASKED_BYLINES`), matching what the forum itself shows, and its
 * `TOPIC_POST_LINKED` event says so through `isAuthorMasked`. The caller only
 * links forum-wide threads, so a topic page never lists a thread its readers
 * could not open.
 */
@Injectable()
export class TopicPostLinkService {
  private readonly logger = new Logger(TopicPostLinkService.name);

  constructor(
    @InjectRepository(Topic) private readonly topics: Repository<Topic>,
    @InjectRepository(TopicPost)
    private readonly topicPosts: Repository<TopicPost>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Best-effort, like `MentionNotificationService.notify`: a failure here
   * must never fail the thread creation it's attached to. `body` is the
   * thread's OP body, passed in by the caller (`ForumThreadsService.create`
   * already holds `input.body`; this service has no post repository of its
   * own to re-fetch it from).
   */
  async linkThread(thread: ForumThread, body: string): Promise<void> {
    if (!thread.tags.length) return;
    try {
      const matchingTopics = await this.topics.find({
        where: { tag: In(thread.tags) },
      });
      if (!matchingTopics.length) return;

      const authorMask = topicPostAuthorMaskFor(thread);
      const { authorName, authorInitials, authorTone } = authorMask
        ? TOPIC_POST_MASKED_BYLINES[authorMask]
        : await this.memberByline(thread.authorId);
      const excerpt =
        body.length > EXCERPT_LIMIT
          ? `${body.slice(0, EXCERPT_LIMIT - 1)}…`
          : body;

      const savedPosts = await this.topicPosts.save(
        matchingTopics.map((topic) =>
          this.topicPosts.create({
            topicId: topic.id,
            forumThreadId: thread.id,
            // The real writer even under a masked byline: `TopicsService.listPosts`
            // reads this column for block/mute filtering only, and no response
            // field carries it.
            authorId: thread.authorId,
            authorName,
            authorInitials,
            authorTone,
            contextLabel: null,
            kind: 'thread',
            category: 'thread',
            title: thread.title,
            body: excerpt,
            reactionCount: 0,
            reactionLabel: 'relate',
            replyCount: 0,
            replyLabel: 'replies',
            tags: thread.tags,
            href: `/thread/${thread.slug}`,
          }),
        ),
      );

      // Denormalized counter bump, the same posture as `followerCount`
      // (`topic.entity.ts`'s docstring): maintained alongside the write so no
      // directory read has to derive it from a `COUNT(*)` join.
      await Promise.all(
        matchingTopics.map((topic) =>
          this.topics.increment({ id: topic.id }, 'totalPosts', 1),
        ),
      );

      // One event per (topic, post). `TopicPostLinkedEvent`'s docstring
      // explains why this fans out once per topic.
      for (let index = 0; index < savedPosts.length; index += 1) {
        const topic = matchingTopics[index]!;
        const post = savedPosts[index]!;
        const event: TopicPostLinkedEvent = {
          topicId: topic.id,
          topicSlug: topic.tag,
          topicLabel: topic.label,
          postId: post.id,
          threadSlug: thread.slug,
          threadTitle: thread.title,
          authorId: thread.authorId,
          isAuthorMasked: authorMask !== null,
        };
        this.eventEmitter.emit(TOPIC_POST_LINKED, event);
      }
    } catch (error) {
      this.logger.warn(`Topic post link failed: ${String(error)}`);
    }
  }

  /**
   * The writer's own byline, for a thread whose byline is not masked. A null
   * author (erased, ENG-494) has no profile to read and takes
   * `ERASED_AUTHOR_TOPIC_BYLINE`.
   */
  private async memberByline(
    authorId: string | null,
  ): Promise<TopicPostMaskedByline> {
    if (authorId === null) return ERASED_AUTHOR_TOPIC_BYLINE;
    const authorProfile = await this.profiles.findOne({
      where: { userId: authorId },
    });
    return {
      authorName: authorProfile
        ? `${authorProfile.firstName} ${authorProfile.lastName}`.trim() ||
          'A member'
        : 'A member',
      authorInitials: authorProfile
        ? initialsFor(authorProfile.firstName, authorProfile.lastName)
        : 'QP',
      authorTone: toneForSlug(authorProfile?.slug ?? authorId),
    };
  }
}
