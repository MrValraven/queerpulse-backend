import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { UsersModule } from '../users/users.module';
import { BarterController } from './barter.controller';
import { BarterService } from './barter.service';
import { BarterListing } from './entities/barter-listing.entity';
import { BarterProposal } from './entities/barter-proposal.entity';

/**
 * The skill exchange (`/barter`): swap listings and the proposals members make
 * against them.
 *
 * All five imports are one-way. None of these modules depends back on
 * `BarterModule`, so no `forwardRef()` is needed:
 *  - `UsersModule` re-exports `TypeOrmModule`, giving the `Profile` repository
 *    that `MemberLookup` hydrates member refs from.
 *  - `SocialModule` exports `BlockFilterService` (board filtering + the hard
 *    stop on proposing to someone either party blocked).
 *  - `MessagingModule` exports `MessagingService`, whose `deliverEnquiry` puts
 *    a new proposal in the listing owner's inbox — the same cross-domain
 *    delivery `HousingListingsService.createEnquiry` uses.
 *  - `SubmissionsModule` exports `SubmissionDecisionNotifier`, which tells a
 *    PROPOSER their swap was accepted or declined (PRD-43). A plain import: it
 *    pulls in `NotificationsModule` only and nothing there reaches back here.
 *  - `NotificationsModule` exports `NotificationsService`, which rings the
 *    owner's bell on a new proposal (`BarterProposalReceived`). The DM above
 *    is the conversation; this is the notification. Plain import, no
 *    `forwardRef`: `NotificationsModule` only pulls in `SocialModule` and
 *    TypeORM features, never `BarterModule`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([BarterListing, BarterProposal]),
    UsersModule,
    SocialModule,
    MessagingModule,
    NotificationsModule,
    SubmissionsModule,
  ],
  controllers: [BarterController],
  providers: [BarterService],
})
export class BarterModule {}
