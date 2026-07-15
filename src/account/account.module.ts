import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDeactivation } from './entities/account-deactivation.entity';
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
    ]),
  ],
  controllers: [AccountController],
  providers: [AccountService],
  exports: [AccountService],
})
export class AccountModule {}
