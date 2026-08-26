import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module';
import { ListingsModule } from '../listings/listings.module';
import { CommunitiesModule } from '../communities/communities.module';
import { EventsModule } from '../events/events.module';
import { ForumModule } from '../forum/forum.module';
import { MagazineModule } from '../magazine/magazine.module';
import { JobsModule } from '../jobs/jobs.module';
import { HousingListingsModule } from '../housing-listings/housing-listings.module';
import { ResourcesModule } from '../resources/resources.module';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { ContentModule } from '../content/content.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [
    ProfilesModule,
    ListingsModule,
    CommunitiesModule,
    EventsModule,
    ForumModule,
    MagazineModule,
    JobsModule,
    HousingListingsModule,
    ResourcesModule,
    SubprofilesModule,
    ContentModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
