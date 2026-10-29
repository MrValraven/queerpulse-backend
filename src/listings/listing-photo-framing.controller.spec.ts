import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { allowsSharedUploads } from '../storage/shared-upload-handlers';
import { UserRole } from '../users/entities/user.entity';
import { AdminListingsController } from './admin-listings.controller';
import { UpdateListingPhotoFramingDto } from './dto/update-listing-photo-framing.dto';
import { ListingClaimsService } from './listing-claims.service';
import { ListingCoManagersService } from './listing-co-managers.service';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingOwnerOffersService } from './listing-owner-offers.service';
import { ListingOwnerPendingService } from './listing-owner-pending.service';
import { ListingVenueEventsService } from './listing-venue-events.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';
import { MySuggestedListingsService } from './my-suggested-listings.service';

describe('Listing photo framing routes', () => {
  const listingRef = 'QPL-2026-0001';
  const body: UpdateListingPhotoFramingDto = {
    photos: [
      {
        image: 'listing/photo-one.jpg',
        framing: { focusX: 0.25, focusY: 0.75, zoom: 2 },
      },
    ],
  };
  const photoGalleryResult = { photoGallery: [] };

  let service: {
    updatePhotoFraming: jest.Mock;
    adminUpdatePhotoFraming: jest.Mock;
  };
  let memberController: ListingsController;
  let adminController: AdminListingsController;

  beforeEach(() => {
    service = {
      updatePhotoFraming: jest.fn().mockResolvedValue(photoGalleryResult),
      adminUpdatePhotoFraming: jest.fn().mockResolvedValue(photoGalleryResult),
    };
    memberController = new ListingsController(
      service as unknown as ListingsService,
      {} as ListingClaimsService,
      {} as ListingOwnerPendingService,
      {} as ListingVenueEventsService,
      {} as MySuggestedListingsService,
    );
    adminController = new AdminListingsController(
      service as unknown as ListingsService,
      {} as ListingEditSuggestionsService,
      {} as ListingClaimsService,
      {} as ListingOwnerOffersService,
      {} as ListingCoManagersService,
    );
  });

  it('PATCH /listings/:ref/photo-framing forwards the ref, the caller and the body', async () => {
    const caller: CurrentUserData = { userId: 'owner-1' } as CurrentUserData;

    const result = await memberController.updatePhotoFraming(
      caller,
      listingRef,
      body,
    );

    expect(service.updatePhotoFraming).toHaveBeenCalledWith(
      listingRef,
      'owner-1',
      body,
    );
    expect(result).toBe(photoGalleryResult);
  });

  it('PATCH /admin/listings/:ref/photo-framing forwards the ref, the admin and the body', async () => {
    const admin: CurrentUserData = { userId: 'admin-1' } as CurrentUserData;

    const result = await adminController.updatePhotoFraming(
      listingRef,
      admin,
      body,
    );

    expect(service.adminUpdatePhotoFraming).toHaveBeenCalledWith(
      listingRef,
      'admin-1',
      body,
    );
    expect(result).toBe(photoGalleryResult);
  });

  it('narrows the admin route to admins with an empty staff-role override', () => {
    const reflector = new Reflector();
    const handler = Object.getOwnPropertyDescriptor(
      AdminListingsController.prototype,
      'updatePhotoFraming',
    )?.value as (...args: never[]) => unknown;

    expect(reflector.get(ROLES_KEY, handler)).toEqual([UserRole.Admin]);
    expect(reflector.get(STAFF_ROLES_KEY, handler)).toEqual([]);
  });

  it('keeps restricted members off the member route', () => {
    const handler = Object.getOwnPropertyDescriptor(
      ListingsController.prototype,
      'updatePhotoFraming',
    )?.value as (...args: never[]) => unknown;
    const guards =
      (Reflect.getMetadata(GUARDS_METADATA, handler) as
        unknown[] | undefined) ?? [];

    expect(guards).toContain(NotRestrictedGuard);
  });

  it('lets both routes name photos another member uploaded', () => {
    expect(
      allowsSharedUploads('ListingsController', 'updatePhotoFraming'),
    ).toBe(true);
    expect(
      allowsSharedUploads('AdminListingsController', 'updatePhotoFraming'),
    ).toBe(true);
  });
});
