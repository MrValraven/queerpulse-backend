import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Event } from '../events/entities/event.entity';
import { PlatformSettingsModule } from '../platform-settings/platform-settings.module';
import { StorageModule } from '../storage/storage.module';
import { Profile } from '../users/entities/profile.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { User } from '../users/entities/user.entity';
import { AdminVjController } from './admin-vj.controller';
import { AdminVjLiveController } from './admin-vj-live.controller';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import { VjScene } from './entities/vj-scene.entity';
import { VjSetlistItem } from './entities/vj-setlist-item.entity';
import { VjSetlist } from './entities/vj-setlist.entity';
import { VjEventLinkService } from './vj-event-link.service';
import { VjGateway } from './vj.gateway';
import { VjLibraryService } from './vj-library.service';
import { VjSceneService } from './vj-scene.service';
import { VjSetlistService } from './vj-setlist.service';
import { VjStageReadsService } from './vj-stage-reads.service';
import { VjStageService } from './vj-stage.service';

/**
 * The VJ feature: the library at `admin/vj` (packs, clips, pack event links,
 * scenes and set lists), the in-memory stages and the `/vj` socket namespace
 * that drives them, open to an Admin and to a holder of the `vj_operator`
 * staff grant. Exports nothing; no other module reads VJ.
 * `ConfigService` (the event card's frontend URL, the socket secret) comes
 * from the global config module, so no `ConfigModule` import.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      // The VJ tables.
      VjClip,
      VjPack,
      VjPackClip,
      VjScene,
      VjSetlist,
      VjSetlistItem,
      // Read-only: the pack event link check, the event card and the
      // upcoming events list read `events`; nothing here writes it.
      Event,
      // `Profile` gives clips and packs their creator names, and `User` backs
      // the socket's role check.
      Profile,
      User,
      // Read-only: `RolesOrStaffGuard` on this module's controller and the
      // socket handshake and per-frame recheck read the caller's
      // `vj_operator` grant when their account tier is not Admin. Same
      // registration precedent as `LandingModule` and `HousingListingsModule`.
      UserStaffRole,
      // Read-side only: the socket handshake asks whether the session behind
      // the access token is still live, as on `/quizshow`.
      RefreshToken,
    ]),
    // `StorageService`: upload checks, presigned clip URLs, object deletes.
    StorageModule,
    // `PlatformSettingsService`: the socket handshake and reauth apply the
    // lockdown rule to a caller let in by the `vj_operator` grant.
    PlatformSettingsModule,
    // The gateway verifies the handshake token itself and passes the secret
    // on each call, as `ChatGateway` does, so no defaults.
    JwtModule.register({}),
  ],
  controllers: [AdminVjController, AdminVjLiveController],
  providers: [
    VjLibraryService,
    VjStageService,
    VjStageReadsService,
    VjEventLinkService,
    VjSceneService,
    VjSetlistService,
    VjGateway,
  ],
})
export class VjModule {}
