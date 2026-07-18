import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { Connection } from '../connections/entities/connection.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { Event } from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { Message } from '../messaging/entities/message.entity';
import { Activity } from '../profiles/entities/activity.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AccountDeletionProcessorService } from './account-deletion-processor.service';
import { AccountExportService } from './account-export.service';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import { DataExportJob } from './entities/data-export-job.entity';
import { DeletionRequest } from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';
import { EmailPreference } from './entities/email-preference.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DeletionRequest,
      DsarRequest,
      DataExportJob,
      EmailPreference,
      AccountReauthToken,
      AccountDeactivation,
      // Reuses the existing refresh-token store (owned by `src/auth`) for
      // session listing/revocation — registered here (not exported by
      // `AuthModule`) rather than re-implemented. See the module's own
      // `TypeOrmModule.forFeature` registration in `src/auth/auth.module.ts`;
      // TypeORM permits the same entity's repository being registered in
      // more than one module.
      RefreshToken,
      // The suppression list survives account erasure and has no FK to
      // `users` — see the entity for why.
      EmailSuppression,
      // Read-only sources for the Art. 20 archive (`AccountExportService`) and,
      // for `User`, the row the erasure sweep deletes. Registered the same way
      // `RefreshToken` is above: the owning module keeps its own
      // `forFeature`, and TypeORM allows the same entity in more than one.
      User,
      Profile,
      Message,
      ForumThread,
      ForumPost,
      Event,
      EventRsvp,
      Connection,
      Vouch,
      Activity,
    ]),
  ],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountExportService,
    // Cron-only; nothing injects it. Registering it here is what starts the
    // daily erasure sweep.
    AccountDeletionProcessorService,
  ],
  exports: [AccountService],
})
export class AccountModule {}
