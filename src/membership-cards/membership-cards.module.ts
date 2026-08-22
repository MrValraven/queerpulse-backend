import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { Community } from '../communities/entities/community.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Profile } from '../users/entities/profile.entity';
import { CardHoldersService } from './card-holders.service';
import { CardProgramsService } from './card-programs.service';
import { CardSerialService } from './card-serial.service';
import { CardTokenService } from './card-token.service';
import { CardVerificationController } from './card-verification.controller';
import { CardVerificationService } from './card-verification.service';
import { CommunityCard } from './entities/community-card.entity';
import { MembershipCard } from './entities/membership-card.entity';
import { MembershipCardListener } from './membership-card.listener';
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
 * `MembershipCardScan` is deliberately NOT registered here: nothing in this
 * module injects its repository yet (it is a Phase 2 door-scanning surface
 * whose table exists from Task 1's migration but has no reader/writer until
 * that phase is built).
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
      Community,
      CommunityMember,
      Profile,
    ]),
    CommunityMembershipModule,
    CommunitiesModule,
  ],
  controllers: [
    MembershipCardsController,
    CommunityCardsController,
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
    MembershipCardListener,
  ],
  // `MembershipCardsService` and `MyCardsService` are exported so
  // `AccountModule` can inject `MyCardsService.forUser(userId)` into the
  // Art. 20 data-export archive (`membershipCards` category).
  exports: [MembershipCardsService, MyCardsService],
})
export class MembershipCardsModule {}
