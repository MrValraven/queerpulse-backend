import { Identity, IdentityKind } from './entities/identity.entity';
import { IdentitiesService } from './identities.service';

/**
 * Task 18: `IdentitiesService.isRemovedPersona`, the read behind the
 * `IDENTITY_REMOVED` refusal a customer meets when writing to a persona
 * moderation took down.
 */
function makeService(
  subprofileRows: Array<{ id: string; removedAt: Date | null }>,
) {
  const service = Object.create(
    IdentitiesService.prototype,
  ) as IdentitiesService;
  const subprofiles = { find: jest.fn().mockResolvedValue(subprofileRows) };
  Object.assign(service, { subprofiles });
  return { service, subprofiles };
}

const PERSONA_IDENTITY = {
  id: 'persona-identity',
  kind: IdentityKind.Subprofile,
  subprofileId: 'persona-1',
} as Identity;

describe('IdentitiesService.isRemovedPersona', () => {
  it('is true for a persona with removed_at set', async () => {
    const { service } = makeService([
      { id: 'persona-1', removedAt: new Date('2026-09-01T10:00:00Z') },
    ]);
    await expect(service.isRemovedPersona(PERSONA_IDENTITY)).resolves.toBe(
      true,
    );
  });

  it('is false for a live persona', async () => {
    const { service } = makeService([{ id: 'persona-1', removedAt: null }]);
    await expect(service.isRemovedPersona(PERSONA_IDENTITY)).resolves.toBe(
      false,
    );
  });

  it('is false for any other kind, without a query', async () => {
    const { service, subprofiles } = makeService([]);
    await expect(
      service.isRemovedPersona({
        id: 'company-identity',
        kind: IdentityKind.Company,
        companyId: 'company-1',
      } as Identity),
    ).resolves.toBe(false);
    expect(subprofiles.find).not.toHaveBeenCalled();
  });
});
