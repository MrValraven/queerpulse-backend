import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Connection } from '../connections/entities/connection.entity';
import { ReportsModule } from '../reports/reports.module';
import { UsersModule } from '../users/users.module';
import { BlockFilterService } from './block-filter.service';
import { BlocksController } from './blocks.controller';
import { Block } from './entities/block.entity';
import { Mute } from './entities/mute.entity';
import { MutesController } from './mutes.controller';
import { SocialService } from './social.service';

/**
 * Blocks & mutes — always-on safety primitives (spec §2/§3 Tier 1 "social").
 * Deliberately absent from `launchedFeatures.ts` (like `account`/`consent`):
 * no `@Feature` flag gates these controllers.
 *
 * Exports `BlockFilterService` for other domains (messaging, connections,
 * profiles/members directory, feed) to wire in later.
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
 * for this one write; it does not depend on `ConnectionsService`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Block, Mute, Connection]),
    UsersModule,
    ReportsModule,
  ],
  controllers: [BlocksController, MutesController],
  providers: [SocialService, BlockFilterService],
  exports: [BlockFilterService, SocialService],
})
export class SocialModule {}
