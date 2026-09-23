import { ForbiddenException } from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MessagingCoreService } from './messaging-core.service';

function makeCore(kind: IdentityKind) {
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    identities: {
      getById: jest.fn().mockResolvedValue({ id: 'identity-1', kind }),
    },
  });
  return core;
}

describe('assertInitiatorIsProfile', () => {
  it('allows a member acting as themselves to open a thread', async () => {
    await expect(
      makeCore(IdentityKind.Profile).assertInitiatorIsProfile('identity-1'),
    ).resolves.toBeUndefined();
  });

  it.each([
    IdentityKind.Listing,
    IdentityKind.Subprofile,
    IdentityKind.Company,
  ])('refuses %s as an initiator', async (kind) => {
    await expect(
      makeCore(kind).assertInitiatorIsProfile('identity-1'),
    ).rejects.toThrow(ForbiddenException);
  });
});
