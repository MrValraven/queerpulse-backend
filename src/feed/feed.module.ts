import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityPostReaction } from '../communities/entities/community-post-reaction.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { Event } from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { SocialModule } from '../social/social.module';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { UsersModule } from '../users/users.module';
import { FeedSourceMute } from './entities/feed-source-mute.entity';
import { FeedController } from './feed.controller';
import { FeedInteractionsService } from './feed-interactions.service';
import { FeedMuteController } from './feed-mute.controller';
import { FeedMuteService } from './feed-mute.service';
import { FeedService } from './feed.service';

/**
 * Read-time feed aggregation (spec §3 Tier 3 "feed"). No entity/migration of
 * its own — it only *reads* the source domains' tables via a redundant
 * `TypeOrmModule.forFeature` registration (the same idiom
 * `CommunitiesModule` uses for `Profile`), so it never needs to import
 * `CommunitiesModule`/`ForumModule`/`EventsModule` themselves (none of them
 * export their entity repositories, only their services).
 *
 * `UsersModule` supplies the `Profile` repository (for `MemberLookup`,
 * resolving authors/hosts to `AuthorSummary`) — see `ForumModule`'s import
 * for the same idiom. `SocialModule` supplies `BlockFilterService` for the
 * cross-cutting block enforcement (spec §2). `ConnectionsModule` supplies
 * `ConnectionsService`, used to scope the `connections` tab (DISC-2) to the
 * viewer's accepted-connection author set.
 *
 * SOC-04/SOC-18 add the module's FIRST owned table, `feed_source_mutes`
 * (`FeedSourceMute`), plus three more read-only registrations following the
 * same redundant-`forFeature` idiom: `TopicFollow` (the viewer's followed
 * topics, one of the three explicit graph facts the "All" tab ranks on) and
 * `CommunityPostReaction`/`CommunityPostReply` (the reaction and reply counts
 * that let a feed card act inline instead of only linking out). The writes
 * behind those two still belong to `CommunityPostsService`; the feed only
 * counts them.
 *
 * ENG-132/PRD-167 add `ForumPost` on the same read-only idiom. The feed
 * reads it for exactly two things, batched once per page: the live count of a
 * thread's non-deleted replies (the denormalized `forum_thread.reply_count`
 * still counts tombstoned ones) and the opening post's body, which becomes
 * the card's excerpt. Every write to that table stays with
 * `ForumPostsService`.
 *
 * ENG-131 uses `SocialModule`'s second export, `HiddenFromService`: the
 * feed's two new-member sources announce the same people the member directory
 * gates, so they apply the directory's "hide my profile from this person"
 * predicate in-query. No new module edge, the import was already here.
 *
 * PRD-10 adds one more read-only registration on that same idiom,
 * `MemberPreferences`: the viewer's three content-sensitivity switches, read
 * once per feed request and resolved into the tag sets the candidate queries
 * exclude on (`src/feed/content-sensitivity.ts`). Registering the repository
 * rather than importing `PreferencesModule` keeps the module graph acyclic,
 * and the write side of that table stays entirely with `PreferencesService`.
 *
 * PRD-107 adds `MagazineArticle` and `MagazineAuthor` on that same read-only
 * idiom, so a published piece can reach the home feed. `MagazineModule` is
 * deliberately NOT imported: it exports no repository, and importing it would
 * pull the whole desk (issues, pitches, payments, story submissions) into the
 * feed's graph to read two tables. Every write to both stays with the desk's
 * own services.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunityPost,
      Community,
      ForumThread,
      ForumPost,
      Event,
      CommunityMember,
      CommunityPostReaction,
      CommunityPostReply,
      TopicFollow,
      MemberPreferences,
      MagazineArticle,
      MagazineAuthor,
      FeedSourceMute,
    ]),
    UsersModule,
    SocialModule,
    ConnectionsModule,
  ],
  controllers: [FeedController, FeedMuteController],
  providers: [FeedService, FeedInteractionsService, FeedMuteService],
})
export class FeedModule {}
