import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Listing } from '../listings/entities/listing.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { SafeSpaceMemberVouch } from './entities/safe-space-vouch.entity';
import { SafeSpaceVouchesController } from './safe-space-vouches.controller';
import { SafeSpaceVouchesService } from './safe-space-vouches.service';

/**
 * Member-facing safe-space vouch writes. `Listing` is registered here only to
 * resolve a space by its slug (and verify it is a live, verified safe space)
 * before inserting a vouch — the listings domain itself lives in
 * `ListingsModule`, which owns the read path that merges these rows into the
 * safe-space detail DTO.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([SafeSpaceMemberVouch, Listing]),
    // Provides `NotificationsService` so `createVouch` can tell the space's
    // owner. `NotificationsModule` imports only `SocialModule` + TypeORM, so it
    // never reaches back here — no cycle, plain import.
    NotificationsModule,
  ],
  controllers: [SafeSpaceVouchesController],
  providers: [SafeSpaceVouchesService],
})
export class SafeSpaceVouchesModule {}
