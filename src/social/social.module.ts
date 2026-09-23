import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { IdentitiesModule } from '../identities/identities.module';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { BlockFilterService } from './block-filter.service';
import { BlocksController } from './blocks.controller';
import { Block } from './entities/block.entity';
import { HiddenFromMember } from './entities/hidden-from.entity';
import { Mute } from './entities/mute.entity';
import { HiddenFromController } from './hidden-from.controller';
import { HiddenFromService } from './hidden-from.service';
import { IdentityBlocksController } from './identity-blocks.controller';
import { IdentityBlocksService } from './identity-blocks.service';
import { MutesController } from './mutes.controller';
import { SocialService } from './social.service';

/**
 * Blocks, mutes & hidden-from — always-on safety primitives (spec §2/§3 Tier
 * 1 "social"). Deliberately absent from `launchedFeatures.ts` (like
 * `account`/`consent`): no `@Feature` flag gates these controllers.
 *
 * `hidden_from_members` (member profile v2 Task 5, `HiddenFromService`/
 * `HiddenFromController`) is a new, distinct capability from block/mute:
 * one-way, silent, and narrower — it only affects whether a member's profile
 * can be found (search + direct URL), modeled on `BlockFilterService`'s
 * `NOT EXISTS` filter idiom but kept as its own service/table rather than
 * folded into `BlockFilterService`, since it isn't part of that "hard
 * severance vs. soft silence" pair.
 *
 * Exports `BlockFilterService` and `HiddenFromService` for other domains
 * (messaging, connections, profiles/members directory, feed) to wire in.
 *
 * Imports `ReportsModule` so `SocialService.blockMember`'s `alsoReport: true`
 * path can create a `Report` via `ReportsService`. `ReportsModule` does not
 * import anything from `social`, so this is a plain one-way import — no
 * `forwardRef` needed.
 *
 * Registers the `Connection` entity directly (rather than importing
 * `ConnectionsModule`) so `blockMember` can sever an existing connection edge
 * in the same transaction as the block insert — `ConnectionsModule` already
 * imports `SocialModule` for `BlockFilterService`, so importing it back here
 * would be a cycle. `SocialService` talks to the `connections` table directly
 * for this one write; it does not depend on `ConnectionsService`. Same reason
 * `HiddenFromController` builds its own `MemberLookup` from the `Profile`
 * repo (available via `UsersModule`, imported below) instead of importing
 * `ProfilesModule`, which also imports `SocialModule`.
 *
 * Task 14: registers `IdentityBlock` for `BlockFilterService`'s identity
 * checks and `IdentityBlocksService`, and imports `IdentitiesModule` for the
 * identity's kind, staff and display fields. `IdentitiesModule` imports
 * nothing but its own entities, so this is a plain one-way import with no
 * `forwardRef`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Block,
      Mute,
      Connection,
      HiddenFromMember,
      IdentityBlock,
    ]),
    UsersModule,
    ReportsModule,
    IdentitiesModule,
  ],
  controllers: [
    BlocksController,
    MutesController,
    HiddenFromController,
    IdentityBlocksController,
  ],
  providers: [
    SocialService,
    BlockFilterService,
    HiddenFromService,
    IdentityBlocksService,
  ],
  exports: [BlockFilterService, SocialService, HiddenFromService],
})
export class SocialModule {}
