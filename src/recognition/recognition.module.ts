import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { RecognitionAward } from './entities/recognition-award.entity';
import { RecognitionPerkClaim } from './entities/recognition-perk-claim.entity';
import { RecognitionStat } from './entities/recognition-stat.entity';
import {
  MemberRecognitionController,
  MyRecognitionController,
} from './recognition.controller';
import { RecognitionService } from './recognition.service';

/**
 * Recognition — badges/kudos a member has earned, level + perks (spec §3
 * Tier 2 "recognition"). Always-on member data, like `profiles`: no
 * `@Feature` flag, absent from `launchedFeatures.ts` (orchestrator wires
 * this module into `app.module.ts`, not done here).
 *
 * Imports `UsersModule` for its re-exported `Profile` repository, used to
 * resolve `slug` → `userId` for `GET /profiles/:slug/recognition` (mirrors
 * `ProfilesModule`'s own import of `UsersModule` for the same reason).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RecognitionStat,
      RecognitionAward,
      RecognitionPerkClaim,
    ]),
    UsersModule,
  ],
  controllers: [MyRecognitionController, MemberRecognitionController],
  providers: [RecognitionService],
})
export class RecognitionModule {}
