import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaReferenceResolver } from './media-reference.resolver';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineDeck } from '../magazine/entities/magazine-deck.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { Message } from '../messaging/entities/message.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Event } from '../events/entities/event.entity';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { CinemaTitle } from '../cinema/entities/cinema-title.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { Changemaker } from '../changemakers/entities/changemaker.entity';
import { Collection } from '../collections/entities/collection.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Company } from '../companies/entities/company.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';

// Registers every entity a `MediaReferenceSource` reads from via
// `DataSource.getRepository` — the resolver never injects 17 repositories
// directly, but `getRepository` still requires the entity to be registered
// with `forFeature` somewhere in the module graph, so this module owns that
// registration for all of them regardless of whether their owning feature
// module is loaded.
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Profile,
      WorkItem,
      MagazineArticle,
      MagazineDeck,
      MagazineIssue,
      Message,
      EventPhoto,
      Conversation,
      Event,
      Subprofile,
      SubprofileItem,
      CommunityPost,
      Community,
      CinemaTitle,
      Landlord,
      MagazineAuthor,
      Changemaker,
      Collection,
      Listing,
      Company,
      HousingListing,
    ]),
  ],
  providers: [MediaReferenceResolver],
  exports: [MediaReferenceResolver],
})
export class MediaReferencesModule {}
