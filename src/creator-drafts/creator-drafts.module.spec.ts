import 'reflect-metadata';
import { CommunitiesModule } from '../communities/communities.module';
import { EventsModule } from '../events/events.module';
import { ListingDraftsModule } from '../listing-drafts/listing-drafts.module';
import { ModerationModule } from '../moderation/moderation.module';
import { StudioCatalogService } from '../studio/studio-catalog.service';
import { StudioModule } from '../studio/studio.module';
import { AdminCreatorDraftRowsService } from './admin-creator-draft-rows.service';
import { AdminCreatorDraftsController } from './admin-creator-drafts.controller';
import { AdminCreatorDraftsService } from './admin-creator-drafts.service';
import { CreatorDraftMadeForService } from './creator-draft-made-for.service';
import { isCreatorDraftRequest } from './creator-draft-request-log';
import { CreatorDraftRetentionService } from './creator-draft-retention.service';
import { CreatorDraftSlotsModule } from './creator-draft-slots.module';
import {
  CREATOR_DRAFT_VISIBILITY,
  DEFAULT_CREATOR_DRAFT_VISIBILITY,
} from './creator-drafts.constants';
import { CreatorDraftsController } from './creator-drafts.controller';
import { CreatorDraftsModule } from './creator-drafts.module';
import { CreatorDraftsService } from './creator-drafts.service';

describe('CreatorDraftsModule wiring', () => {
  it('registers both controllers, every provider and the visibility token', () => {
    expect(Reflect.getMetadata('controllers', CreatorDraftsModule)).toEqual([
      CreatorDraftsController,
      AdminCreatorDraftsController,
    ]);
    const providers = Reflect.getMetadata(
      'providers',
      CreatorDraftsModule,
    ) as unknown[];
    expect(providers).toEqual(
      expect.arrayContaining([
        CreatorDraftsService,
        CreatorDraftMadeForService,
        AdminCreatorDraftRowsService,
        AdminCreatorDraftsService,
        CreatorDraftRetentionService,
        {
          provide: CREATOR_DRAFT_VISIBILITY,
          useValue: DEFAULT_CREATOR_DRAFT_VISIBILITY,
        },
      ]),
    );
  });

  it('imports the modules that export each injected service', () => {
    expect(Reflect.getMetadata('imports', CreatorDraftsModule)).toEqual(
      expect.arrayContaining([ModerationModule, StudioModule]),
    );
  });

  it('exports the Studio catalog for the staff preview', () => {
    expect(Reflect.getMetadata('exports', StudioModule)).toEqual(
      expect.arrayContaining([StudioCatalogService]),
    );
  });

  it('gives the two publish modules the slots module and the listing drafts module the audit writer', () => {
    for (const featureModule of [EventsModule, CommunitiesModule]) {
      expect(Reflect.getMetadata('imports', featureModule)).toEqual(
        expect.arrayContaining([CreatorDraftSlotsModule]),
      );
    }
    expect(Reflect.getMetadata('imports', ListingDraftsModule)).toEqual(
      expect.arrayContaining([ModerationModule]),
    );
  });

  it('keeps creator draft routes out of the pino request log', () => {
    // No existing spec reaches the pino options built in AppModule, so this
    // pins the helper that `autoLogging.ignore` calls.
    expect(isCreatorDraftRequest('/v1/me/creator-drafts/event')).toBe(true);
    expect(isCreatorDraftRequest('/v1/admin/creator-drafts')).toBe(true);
  });
});
