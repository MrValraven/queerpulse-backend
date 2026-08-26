import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import { RecognitionEntitlementsService } from './recognition-entitlements.service';

/**
 * The read-only slice of recognition that other domains enforce against
 * (SUS-04). Imports nothing but the two tables it reads, so importing it can
 * never close a module cycle — `MembershipModule` needs it, and `AuthModule`
 * already imports `MembershipModule`.
 *
 * Not registered in `app.module.ts`: it is imported by the modules that use it
 * (`RecognitionModule`, `MembershipModule`), which is enough for Nest to
 * instantiate it.
 */
@Module({
  imports: [TypeOrmModule.forFeature([RecognitionStat, RecognitionPerkClaim])],
  providers: [RecognitionEntitlementsService],
  exports: [RecognitionEntitlementsService],
})
export class RecognitionEntitlementsModule {}
