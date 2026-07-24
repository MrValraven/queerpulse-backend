import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Event } from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Message } from '../messaging/entities/message.entity';
import { Activity } from '../profiles/entities/activity.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';

/**
 * The Art. 20 archive builder behind `POST /account/export`.
 *
 * Top-level key names are NOT free choice — they are the contract the frontend
 * already ships against. `useExportFlow.ts`'s `buildDemoArchive` produces the
 * demo-mode archive users can download today, and live mode has to be
 * recognisably the same document. Two of the keys deliberately differ from the
 * category id that requests them:
 *
 *   category id     -> archive key
 *   `profile`       -> `profile`
 *   `messages`      -> `messages`
 *   `forumPosts`    -> `posts`      (not `forumPosts`)
 *   `events`        -> `events`
 *   `connections`   -> `connections`
 *   `activityLog`   -> `activity`   (not `activityLog`)
 *
 * A category the caller did not ask for is omitted entirely (the demo archive
 * sets it `undefined`, which `JSON.stringify` drops — same observable result).
 */
@Injectable()
export class AccountExportService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(Message) private readonly messages: Repository<Message>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
    @InjectRepository(ForumPost)
    private readonly forumPosts: Repository<ForumPost>,
    @InjectRepository(Event) private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Connection)
    private readonly connections: Repository<Connection>,
    @InjectRepository(Vouch) private readonly vouches: Repository<Vouch>,
    @InjectRepository(Activity)
    private readonly activities: Repository<Activity>,
  ) {}

  /**
   * Build the whole archive in memory and return it for inline `jsonb` storage.
   *
   * SIZE RISK — read before adding a category. Every row for every requested
   * category is loaded into one object, JSON-serialized, and written into
   * `data_export_job.data`. For a normal member that is kilobytes. For a
   * long-tenured, heavy chat user it is unbounded: `messages` has no cap and no
   * pagination here, and Postgres will refuse a `jsonb` value over 1GB (with
   * the request having already burned that much heap on the way there). The
   * moment exports start timing out or the job table starts bloating, this is
   * the thing to move to a streamed, chunked, object-storage-backed worker —
   * not a bigger timeout.
   */
  async build(
    userId: string,
    categories: string[],
  ): Promise<Record<string, unknown>> {
    const want = new Set(categories);
    const archive: Record<string, unknown> = {
      manifest: {
        exportedAt: new Date().toISOString(),
        schemaVersion: '1.0',
        categories,
      },
    };

    if (want.has('profile')) {
      archive.profile = await this.buildProfile(userId);
    }
    if (want.has('messages')) {
      archive.messages = await this.buildMessages(userId);
    }
    if (want.has('forumPosts')) {
      archive.posts = await this.buildPosts(userId);
    }
    if (want.has('events')) {
      archive.events = await this.buildEvents(userId);
    }
    if (want.has('connections')) {
      archive.connections = await this.buildConnections(userId);
    }
    if (want.has('activityLog')) {
      archive.activity = await this.buildActivity(userId);
    }
    return archive;
  }

  // `profile` — the `users` row joined with its `profiles` row. `googleId` is
  // deliberately excluded: it is an identifier for *our* relationship with
  // Google, not personal data the member gave us, and echoing it back invites
  // it into places it should not be.
  private async buildProfile(
    userId: string,
  ): Promise<Record<string, unknown> | null> {
    const [user, profile] = await Promise.all([
      // `addSelect('user.email')` re-includes the `select: false` email column —
      // the member's own email is core to the data-export archive they receive.
      this.users
        .createQueryBuilder('user')
        .addSelect('user.email')
        .where('user.id = :userId', { userId })
        .getOne(),
      this.profiles.findOne({ where: { userId } }),
    ]);
    if (!user) {
      return null;
    }
    return {
      email: user.email,
      status: user.status,
      role: user.role,
      joinedAt: user.createdAt.toISOString(),
      activatedAt: user.activatedAt ? user.activatedAt.toISOString() : null,
      ...(profile
        ? {
            name: `${profile.firstName} ${profile.lastName}`.trim(),
            firstName: profile.firstName,
            lastName: profile.lastName,
            slug: profile.slug,
            pronouns: profile.pronouns,
            tagline: profile.tagline,
            bio: profile.bio,
            location: profile.location,
            avatarUrl: profile.avatarUrl,
            visibility: profile.visibility,
            identities: profile.identities,
            lookingFor: profile.lookingFor,
            tags: profile.tags,
            openTo: profile.openTo,
            now: profile.now,
            verified: profile.verified,
          }
        : {}),
    };
  }

  // `messages` — messages the member SENT. Messages they only received are
  // someone else's words about them; those belong in that member's export, not
  // this one. Soft-deleted rows are excluded by TypeORM's default
  // `@DeleteDateColumn` filtering: the member already deleted them.
  private async buildMessages(
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.messages.find({
      where: { senderId: userId },
      order: { createdAt: 'ASC' },
    });
    return rows.map((m) => ({
      id: m.id,
      conversationId: m.conversationId,
      body: m.body,
      sentAt: m.createdAt.toISOString(),
      editedAt: m.editedAt ? m.editedAt.toISOString() : null,
    }));
  }

  // `posts` — forum threads the member started plus every reply they wrote.
  private async buildPosts(userId: string): Promise<Record<string, unknown>[]> {
    const [threads, posts] = await Promise.all([
      this.forumThreads.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
      this.forumPosts.find({
        where: { authorId: userId },
        order: { createdAt: 'ASC' },
      }),
    ]);
    return [
      ...threads.map((t) => ({
        type: 'thread' as const,
        id: t.id,
        slug: t.slug,
        title: t.title,
        category: t.category,
        replyCount: t.replyCount,
        createdAt: t.createdAt.toISOString(),
      })),
      ...posts.map((p) => ({
        type: 'reply' as const,
        id: p.id,
        threadId: p.threadId,
        body: p.body,
        voteCount: p.voteCount,
        createdAt: p.createdAt.toISOString(),
      })),
    ];
  }

  // `events` — events the member hosted, plus their own RSVPs. The RSVP entries
  // carry the event's title/date so the archive stands alone rather than being
  // a list of opaque uuids the member cannot interpret.
  private async buildEvents(
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const [hosted, rsvps] = await Promise.all([
      this.events.find({
        where: { hostId: userId },
        order: { startAt: 'ASC' },
      }),
      this.rsvps.find({ where: { userId }, order: { createdAt: 'ASC' } }),
    ]);
    // One extra query for the RSVP'd events rather than N — `In([])` is a no-op
    // guard for the common "never RSVP'd" case.
    const rsvpEventIds = rsvps.map((r) => r.eventId);
    const rsvpEvents = rsvpEventIds.length
      ? await this.events.find({ where: { id: In(rsvpEventIds) } })
      : [];
    const byId = new Map(rsvpEvents.map((e) => [e.id, e]));
    return [
      ...hosted.map((e) => ({
        role: 'host' as const,
        id: e.id,
        slug: e.slug,
        title: e.title,
        description: e.description,
        startAt: e.startAt.toISOString(),
        endAt: e.endAt ? e.endAt.toISOString() : null,
        venue: e.venue,
        isOnline: e.isOnline,
        status: e.status,
      })),
      ...rsvps.map((r) => {
        const event = byId.get(r.eventId);
        return {
          role: 'attendee' as const,
          eventId: r.eventId,
          title: event?.title ?? null,
          startAt: event?.startAt.toISOString() ?? null,
          rsvp: r.status,
          waitlistPosition: r.waitlistPosition,
          respondedAt: r.createdAt.toISOString(),
        };
      }),
    ];
  }

  // `connections` — the member's connection edges (either direction) plus
  // vouches they gave and received. The counterparty is exported as an id only:
  // another member's identity is that member's personal data, not this one's.
  private async buildConnections(
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const [asRequester, asAddressee, given, received] = await Promise.all([
      this.connections.find({ where: { requesterId: userId } }),
      this.connections.find({ where: { addresseeId: userId } }),
      this.vouches.find({ where: { voucherId: userId } }),
      this.vouches.find({ where: { voucheeId: userId } }),
    ]);
    return [
      ...[...asRequester, ...asAddressee].map((c) => ({
        type: 'connection' as const,
        id: c.id,
        direction:
          c.requesterId === userId ? ('sent' as const) : ('received' as const),
        counterpartyId:
          c.requesterId === userId ? c.addresseeId : c.requesterId,
        status: c.status,
        requestMessage: c.requestMessage,
        requestReason: c.requestReason,
        createdAt: c.createdAt.toISOString(),
        respondedAt: c.respondedAt ? c.respondedAt.toISOString() : null,
      })),
      ...given.map((v) => ({
        type: 'vouch' as const,
        direction: 'given' as const,
        id: v.id,
        counterpartyId: v.voucheeId,
        note: v.note,
        createdAt: v.createdAt.toISOString(),
      })),
      ...received.map((v) => ({
        type: 'vouch' as const,
        direction: 'received' as const,
        id: v.id,
        counterpartyId: v.voucherId,
        note: v.note,
        createdAt: v.createdAt.toISOString(),
      })),
    ];
  }

  // `activity` — the member's own activity feed rows.
  private async buildActivity(
    userId: string,
  ): Promise<Record<string, unknown>[]> {
    const rows = await this.activities.find({
      where: { userId },
      order: { occurredAt: 'ASC' },
    });
    return rows.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.title,
      sub: a.sub,
      link: a.toLink,
      occurredAt: a.occurredAt.toISOString(),
    }));
  }
}
