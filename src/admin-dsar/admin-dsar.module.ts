import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DsarRequest } from '../account/entities/dsar-request.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { AdminDsarController } from './admin-dsar.controller';
import { AdminDsarService } from './admin-dsar.service';

@Module({
  // Registers its own `forFeature` copies of `DsarRequest` and `Profile`
  // (TypeORM permits overlapping registrations) rather than importing
  // `AccountModule` / `UsersModule`, the same self-contained pattern as
  // `AdminInvitesModule`. `NotificationsModule` IS imported, because the
  // resolve path fires a real in-app notification through
  // `NotificationsService` (mirroring `AdminCommunitiesModule`).
  imports: [
    TypeOrmModule.forFeature([DsarRequest, Profile]),
    NotificationsModule,
  ],
  controllers: [AdminDsarController],
  providers: [AdminDsarService],
})
export class AdminDsarModule {}
