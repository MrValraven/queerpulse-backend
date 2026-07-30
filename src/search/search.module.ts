import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module';
import { ListingsModule } from '../listings/listings.module';
import { CommunitiesModule } from '../communities/communities.module';
import { EventsModule } from '../events/events.module';
import { ForumModule } from '../forum/forum.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [
    ProfilesModule,
    ListingsModule,
    CommunitiesModule,
    EventsModule,
    ForumModule,
  ],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
