import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { CreatorDraftsController } from './creator-drafts.controller';
import { CreatorDraftsService } from './creator-drafts.service';
import type { SaveCreatorDraftDto } from './dto/save-creator-draft.dto';

const BODY: SaveCreatorDraftDto = {
  payload: { name: 'The Pink Door' },
  payloadVersion: 1,
  baseRevision: 2,
  progress: null,
  missing: null,
};

describe('CreatorDraftsController', () => {
  const service = {
    getDraft: jest.fn(),
    saveDraft: jest.fn(),
    discardDraft: jest.fn(),
  };
  let controller: CreatorDraftsController;

  beforeEach(() => {
    jest.resetAllMocks();
    controller = new CreatorDraftsController(
      service as unknown as CreatorDraftsService,
    );
  });

  it('guards the class with the active-member guard and tags each route with its feature', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, CreatorDraftsController),
    ).toEqual([ActiveMemberGuard]);
    expect(
      Reflect.getMetadata(FEATURE_KEY, CreatorDraftsController),
    ).toBeUndefined();
    const featureOf = (handlerName: keyof CreatorDraftsController) =>
      Reflect.getMetadata(
        FEATURE_KEY,
        CreatorDraftsController.prototype[handlerName],
      ) as string;
    expect(
      ['getEventDraft', 'saveEventDraft', 'discardEventDraft'].map((name) =>
        featureOf(name as never),
      ),
    ).toEqual(['events', 'events', 'events']);
    expect(
      ['getCommunityDraft', 'saveCommunityDraft', 'discardCommunityDraft'].map(
        (name) => featureOf(name as never),
      ),
    ).toEqual(['communities', 'communities', 'communities']);
    expect(
      [
        'getListingEditDraft',
        'saveListingEditDraft',
        'discardListingEditDraft',
      ].map((name) => featureOf(name as never)),
    ).toEqual(['listings', 'listings', 'listings']);
    expect(featureOf('saveCommunityDraft')).toBe('communities');
    expect(featureOf('saveListingEditDraft')).toBe('listings');
  });

  it('serves the contract paths and answers 204 on delete', () => {
    const metadataOf = (
      key: string,
      handlerName: keyof CreatorDraftsController,
    ): unknown =>
      Reflect.getMetadata(key, CreatorDraftsController.prototype[handlerName]);
    expect(Reflect.getMetadata(PATH_METADATA, CreatorDraftsController)).toBe(
      'me/creator-drafts',
    );
    expect(metadataOf(PATH_METADATA, 'saveListingEditDraft')).toBe(
      'listing-edit/:listingRef',
    );
    expect(metadataOf(PATH_METADATA, 'getEventDraft')).toBe('event');
    expect(metadataOf(PATH_METADATA, 'saveCommunityDraft')).toBe('community');
    expect(
      [
        'discardEventDraft',
        'discardCommunityDraft',
        'discardListingEditDraft',
      ].map((name) => metadataOf(HTTP_CODE_METADATA, name as never)),
    ).toEqual([204, 204, 204]);
  });

  it('passes the caller and the listing ref through', async () => {
    await controller.saveListingEditDraft(
      { userId: 'member-1' } as CurrentUserData,
      'QPL-2026-0001',
      BODY,
    );
    expect(service.saveDraft).toHaveBeenCalledWith(
      'member-1',
      { kind: 'listing_edit', listingRef: 'QPL-2026-0001' },
      BODY,
    );
  });

  it('addresses the event and community slots by kind', async () => {
    const user = { userId: 'member-1' } as CurrentUserData;
    await controller.getEventDraft(user);
    await controller.discardCommunityDraft(user);
    expect(service.getDraft).toHaveBeenCalledWith('member-1', {
      kind: 'event',
    });
    expect(service.discardDraft).toHaveBeenCalledWith('member-1', {
      kind: 'community',
    });
  });
});
