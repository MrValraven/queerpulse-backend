import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { ConnectionsModule } from '../connections/connections.module';
import { Connection } from '../connections/entities/connection.entity';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { SocialModule } from '../social/social.module';
import { UsersModule } from '../users/users.module';
import { MemberSuggestionDismissal } from './entities/member-suggestion-dismissal.entity';
import { MemberSuggestionsController } from './member-suggestions.controller';
import { MemberSuggestionsService } from './member-suggestions.service';

/**
 * People discovery (SOC-05).
 *
 * Owns exactly one table, `member_suggestion_dismissals`. Everything else it
 * reads belongs to another feature and is registered through the redundant
 * `TypeOrmModule.forFeature` idiom `FeedModule` already uses, so this module
 * never has to import `CommunitiesModule` (which exports its service, not its
 * repositories) and no existing module has to change to make room for it.
 *
 *  - `UsersModule` supplies the `Profile` repository.
 *  - `SocialModule` supplies `BlockFilterService` and `HiddenFromService`,
 *    the two gates the member directory applies. They are reused rather than
 *    re-derived so a suggestion can never surface someone the directory hides.
 *  - `ConnectionsModule` supplies `ConnectionsService` for the platform's
 *    single definition of "mutual connection"
 *    (`mutualCountsByUserIds`, already batched).
 *  - `ContentModerationModule` supplies the takedown state, so a member a
 *    moderator has hidden is never pushed into anyone's feed.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      MemberSuggestionDismissal,
      CommunityMember,
      Community,
      Connection,
    ]),
    UsersModule,
    SocialModule,
    ConnectionsModule,
    ContentModerationModule,
  ],
  controllers: [MemberSuggestionsController],
  providers: [MemberSuggestionsService],
  exports: [MemberSuggestionsService],
})
export class MemberSuggestionsModule {}
