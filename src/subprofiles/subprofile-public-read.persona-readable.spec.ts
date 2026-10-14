import { NotFoundException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SubprofilePublicReadService } from './subprofile-public-read.service';

const PERSONA_ID = 'e5000000-0000-4000-8000-000000000001';
const VIEWER: CurrentUserData = {
  userId: 'e5000000-0000-4000-8000-000000000002',
  email: 'viewer@example.test',
  status: 'active',
  role: 'member',
};

/**
 * Studio v3 persona posts read through the `/p/<handle>` rule by persona id.
 * Only the collaborators that rule touches are real mocks.
 */
describe('SubprofilePublicReadService.resolveReadablePersona', () => {
  let persona: Partial<Subprofile> | null;
  let subprofiles: { findOne: jest.Mock };
  let membership: { isMember: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let service: SubprofilePublicReadService;

  beforeEach(() => {
    persona = {
      id: PERSONA_ID,
      userId: 'e5000000-0000-4000-8000-000000000009',
      kind: 'dj' as Subprofile['kind'],
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      removedAt: null,
    };
    subprofiles = { findOne: jest.fn(() => Promise.resolve(persona)) };
    membership = { isMember: jest.fn().mockResolvedValue(false) };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    const unused = {} as never;
    service = new SubprofilePublicReadService(
      subprofiles as unknown as Repository<Subprofile>,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      unused,
      blockFilter as unknown as BlockFilterService,
      unused,
      contentModeration as unknown as ContentModerationService,
      unused,
      unused,
      membership as unknown as SubprofileMembershipService,
      unused,
      unused,
    );
  });

  const notFound = new NotFoundException('Persona not found');

  it('lets a signed-out visitor read an open published persona', async () => {
    const readable = await service.resolveReadablePersona(
      PERSONA_ID,
      undefined,
    );
    expect(readable.isOwner).toBe(false);
    expect(readable.persona.id).toBe(PERSONA_ID);
  });

  it('lets an owner read a draft', async () => {
    persona = { ...persona, status: SubprofileStatus.Draft };
    membership.isMember.mockResolvedValue(true);
    await expect(
      service.resolveReadablePersona(PERSONA_ID, VIEWER),
    ).resolves.toEqual(expect.objectContaining({ isOwner: true }));
  });

  it.each([
    ['a missing persona', () => (persona = null)],
    [
      'a draft',
      () => (persona = { ...persona, status: SubprofileStatus.Draft }),
    ],
    [
      'a removed persona',
      () => (persona = { ...persona, removedAt: new Date() }),
    ],
    [
      'a private persona',
      () =>
        (persona = { ...persona, visibility: SubprofileVisibility.Private }),
    ],
  ])('answers a plain 404 for %s', async (_label, arrange) => {
    arrange();
    await expect(
      service.resolveReadablePersona(PERSONA_ID, VIEWER),
    ).rejects.toEqual(notFound);
  });

  it('answers a signed-out visitor a plain 404 for a members-only persona', async () => {
    persona = { ...persona, visibility: SubprofileVisibility.Network };
    await expect(
      service.resolveReadablePersona(PERSONA_ID, undefined),
    ).rejects.toEqual(notFound);
    await expect(
      service.resolveReadablePersona(PERSONA_ID, VIEWER),
    ).resolves.toEqual(expect.objectContaining({ isOwner: false }));
  });

  it('answers a plain 404 under a takedown and across a block', async () => {
    contentModeration.stateFor.mockResolvedValueOnce({
      hidden: true,
      removed: false,
    });
    await expect(
      service.resolveReadablePersona(PERSONA_ID, VIEWER),
    ).rejects.toEqual(notFound);
    blockFilter.isBlockedEitherWay.mockResolvedValueOnce(true);
    await expect(
      service.resolveReadablePersona(PERSONA_ID, VIEWER),
    ).rejects.toEqual(notFound);
  });
});
