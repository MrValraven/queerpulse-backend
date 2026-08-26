import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PublicEligibilityModule } from '../public-eligibility/public-eligibility.module';
import { MemberPreferences } from './entities/member-preferences.entity';
import { PreferencesController } from './preferences.controller';
import { PreferencesService } from './preferences.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([MemberPreferences]),
    // Exports `PublicEligibilityService`: the server-side gate on turning the
    // public profile ON. No cycle: nothing in this repo imports
    // `PreferencesModule`, so the edge runs one way only.
    PublicEligibilityModule,
  ],
  controllers: [PreferencesController],
  providers: [PreferencesService],
  exports: [PreferencesService],
})
export class PreferencesModule {}
