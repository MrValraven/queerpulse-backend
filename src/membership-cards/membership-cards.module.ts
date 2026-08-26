import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { CardExpiryWarningService } from './card-expiry-warning.service';
import { CardHoldersService } from './card-holders.service';
import { CardProgramsService } from './card-programs.service';
import { CardScanLogService } from './card-scan-log.service';
import { CardScanRetentionService } from './card-scan-retention.service';
import { CardSerialService } from './card-serial.service';
import { CardTokenService } from './card-token.service';
import { CardVerificationController } from './card-verification.controller';
import { CardVerificationService } from './card-verification.service';
import { CommunityCard } from './entities/community-card.entity';
import { MembershipCard } from './entities/membership-card.entity';
import { MembershipCardScan } from './entities/membership-card-scan.entity';
import { MembershipCardListener } from './membership-card.listener';
import { CommunityCardVerificationsController } from './community-card-verifications.controller';
import { CommunityCardsController } from './community-cards.controller';
import { MembershipCardsController } from './membership-cards.controller';
import { MembershipCardsService } from './membership-cards.service';
import { MyCardsService } from './my-cards.service';

/**
 * Wires every provider from the earlier membership-cards tasks into DI. Until
 * this module is registered in `AppModule`, the whole feature is dead code:
 * no controller route exists, and `@OnEvent` on `MembershipCardListener`
 * never fires because Nest never instantiates the class.
 *
 * `Profile`, not `User`, is registered here. Display name (`firstName`/
 * `lastName`), `slug`, and `avatarUrl` all live on `Profile` — every service
 * in this module that resolves a holder's identity
 * (`MyCardsService`/`CardHoldersService`/`CardVerificationService`) reads
 * that table, not `users`, which carries no display-name columns.
 * `MembershipCardScan` IS registered: `CardScanLogService` writes one row per
 * verification that actually resolved to a card, and reads it back as an
 * aggregate for the issuer panel plus a per-CARD tally for the holder roster.
 * `CardScanRetentionService` sweeps it on the 90 day window the entity's
 * docblock promises. Nothing here exposes a per-member history, and nothing
 * should: that is the behavioural record the card design forbids. The
 * unauthenticated verify endpoint can never write a row it did not earn,
 * because the write happens only after a signed token has resolved.
 *
 * `CommunityMembershipModule` is imported for `CommunityMembershipService`
 * (owner/mod + roster-membership checks — `assertOwnerOrModBySlug`/
 * `assertMemberBySlug`), which it already exports. `CommunitiesModule` is
 * imported for `CommunityGovernanceLogService` (the programme-upsert /
 * card-status-change audit trail `CardProgramsService` and
 * `MembershipCardsService` write to) — newly exported by that module for
 * this purpose. Neither import closes a cycle: `CommunitiesModule` does not
 * import this module, directly or transitively, so a plain import suffices
 * and `forwardRef` is not needed. This mirrors the precedent `AccountModule`
 * already relies on for the same two services.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      CommunityCard,
      MembershipCard,
      MembershipCardScan,
      Community,
      CommunityMember,
      Profile,
    ]),
    CommunityMembershipModule,
    CommunitiesModule,
    // `NotificationsService` — the T-30 card-expiry warning
    // (`CardExpiryWarningService`) is the only thing in this module that
    // notifies. Plain import, no `forwardRef`: `NotificationsModule` imports
    // `SocialModule` and `CommunityMembershipModule`, and neither reaches
    // `MembershipCardsModule`, so there is no cycle to break.
    NotificationsModule,
  ],
  controllers: [
    MembershipCardsController,
    CommunityCardsController,
    CommunityCardVerificationsController,
    CardVerificationController,
  ],
  providers: [
    CardSerialService,
    CardTokenService,
    CardProgramsService,
    MembershipCardsService,
    MyCardsService,
    CardHoldersService,
    CardVerificationService,
    CardScanLogService,
    CardScanRetentionService,
    CardExpiryWarningService,
    MembershipCardListener,
  ],
  // `MembershipCardsService` and `MyCardsService` are exported so
  // `AccountModule` can inject `MyCardsService.forUser(userId)` into the
  // Art. 20 data-export archive (`membershipCards` category).
  exports: [MembershipCardsService, MyCardsService],
})
export class MembershipCardsModule {}
