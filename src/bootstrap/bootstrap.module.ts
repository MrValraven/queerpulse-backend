import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module';
import { SavedModule } from '../saved/saved.module';
import { SocialModule } from '../social/social.module';
import { BootstrapController } from './bootstrap.controller';
import { BootstrapService } from './bootstrap.service';

@Module({
  imports: [ProfilesModule, SavedModule, SocialModule],
  controllers: [BootstrapController],
  providers: [BootstrapService],
})
export class BootstrapModule {}
