import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Profile } from '../users/entities/profile.entity';
import { DiscoverableIdentitiesService } from './discoverable-identities.service';
import {
  labelsForFacets,
  publishableFor,
  pruneDiscoverable,
} from './identities';

function profile(over: Partial<Profile> = {}): Profile {
  return {
    userId: 'u1',
    identities: [],
    discoverableIdentities: [],
    ...over,
  } as Profile;
}

describe('DiscoverableIdentitiesService', () => {
  let service: DiscoverableIdentitiesService;
  let repo: { findOne: jest.Mock; update: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn(), update: jest.fn().mockResolvedValue({}) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DiscoverableIdentitiesService,
        { provide: getRepositoryToken(Profile), useValue: repo },
      ],
    }).compile();
    service = module.get(DiscoverableIdentitiesService);
  });

  describe('get', () => {
    it('is empty for a member who has never opted in', async () => {
      repo.findOne.mockResolvedValue(
        profile({ identities: ['Lesbian', 'Trans'] }),
      );

      await expect(service.get('u1')).resolves.toEqual({
        available: ['Lesbian', 'Trans'],
        published: [],
      });
    });

    it('never offers "Prefer not to say" as publishable', async () => {
      repo.findOne.mockResolvedValue(
        profile({ identities: ['Gay', 'Prefer not to say'] }),
      );

      const result = await service.get('u1');
      expect(result.available).toEqual(['Gay']);
    });

    it('404s when the profile does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.get('u1')).rejects.toBeInstanceOf(NotFoundException);
    });

    // Defence in depth: even if a row somehow held a published identity the
    // member no longer declares, the READ must not claim it is published.
    it('does not report a published identity the member no longer holds', async () => {
      repo.findOne.mockResolvedValue(
        profile({
          identities: ['Lesbian'],
          discoverableIdentities: ['Lesbian', 'Trans'],
        }),
      );

      const result = await service.get('u1');
      expect(result.published).toEqual(['Lesbian']);
    });
  });

  describe('update — the subset invariant', () => {
    it('publishes identities the member holds privately', async () => {
      repo.findOne.mockResolvedValue(
        profile({ identities: ['Lesbian', 'Trans', 'Queer'] }),
      );

      await expect(
        service.update('u1', { identities: ['Lesbian', 'Queer'] }),
      ).resolves.toEqual({
        available: ['Lesbian', 'Trans', 'Queer'],
        published: ['Lesbian', 'Queer'],
      });
      expect(repo.update).toHaveBeenCalledWith(
        { userId: 'u1' },
        { discoverableIdentities: ['Lesbian', 'Queer'] },
      );
    });

    it('422s when publishing an identity the member has not declared', async () => {
      repo.findOne.mockResolvedValue(profile({ identities: ['Lesbian'] }));

      await expect(
        service.update('u1', { identities: ['Lesbian', 'Trans'] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('names the offending identities in the 422 so the client can correct itself', async () => {
      repo.findOne.mockResolvedValue(profile({ identities: ['Lesbian'] }));

      await expect(
        service.update('u1', { identities: ['Trans', 'Gay'] }),
      ).rejects.toMatchObject({
        response: { reason: 'not-declared', identities: ['Trans', 'Gay'] },
      });
    });

    it('refuses to publish "Prefer not to say" even when privately held', async () => {
      repo.findOne.mockResolvedValue(
        profile({ identities: ['Prefer not to say'] }),
      );

      await expect(
        service.update('u1', { identities: ['Prefer not to say'] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('un-publishes everything on an empty list', async () => {
      repo.findOne.mockResolvedValue(
        profile({
          identities: ['Lesbian', 'Trans'],
          discoverableIdentities: ['Lesbian', 'Trans'],
        }),
      );

      const result = await service.update('u1', { identities: [] });
      expect(result.published).toEqual([]);
      expect(repo.update).toHaveBeenCalledWith(
        { userId: 'u1' },
        { discoverableIdentities: [] },
      );
    });

    it('de-duplicates a repeated identity', async () => {
      repo.findOne.mockResolvedValue(profile({ identities: ['Gay'] }));

      const result = await service.update('u1', {
        identities: ['Gay', 'Gay'],
      });
      expect(result.published).toEqual(['Gay']);
    });
  });
});

describe('pruneDiscoverable — the removal case', () => {
  // The one that matters: a member retracts a private identity, and the
  // published copy must not linger. ProfilesService.updateMe runs this on every
  // profile write for exactly this reason.
  it('drops a published identity once it is removed from the private list', () => {
    const published = ['Lesbian', 'Disabled or chronically ill'];
    const identitiesAfterRemoval = ['Lesbian'];

    expect(pruneDiscoverable(published, identitiesAfterRemoval)).toEqual([
      'Lesbian',
    ]);
  });

  it('clears the published set entirely when all private identities are removed', () => {
    expect(pruneDiscoverable(['Gay', 'Queer'], [])).toEqual([]);
  });

  it('leaves an untouched published set alone (idempotent)', () => {
    const published = ['Gay', 'Queer'];
    expect(pruneDiscoverable(published, ['Gay', 'Queer', 'Trans'])).toEqual(
      published,
    );
  });

  it('drops "Prefer not to say" even though it is privately held', () => {
    expect(
      pruneDiscoverable(['Prefer not to say'], ['Prefer not to say']),
    ).toEqual([]);
  });

  it('drops values outside the canonical vocabulary', () => {
    expect(pruneDiscoverable(['Freetext'], ['Freetext'])).toEqual([]);
  });

  it('preserves the private list order', () => {
    expect(
      pruneDiscoverable(['Queer', 'Gay'], ['Gay', 'Queer', 'Trans']),
    ).toEqual(['Queer', 'Gay']);
  });
});

describe('publishableFor', () => {
  it('is empty when the member has declared nothing', () => {
    expect(publishableFor([])).toEqual([]);
  });

  it('ignores stored values outside the canonical vocabulary', () => {
    expect(publishableFor(['Gay', 'Something else'])).toEqual(['Gay']);
  });
});

describe('labelsForFacets — the directory query translation', () => {
  it('expands a coarse facet to every label it covers', () => {
    expect(labelsForFacets(['transNonBinary'])).toEqual([
      'Trans',
      'Non-binary',
      'Genderqueer',
      'Genderfluid',
      'Two-spirit',
    ]);
  });

  it('maps each of the seven directory facets to at least one label', () => {
    for (const facet of [
      'transNonBinary',
      'lesbian',
      'gay',
      'biPan',
      'aroAce',
      'qpoc',
      'disabledChronicIllness',
    ]) {
      expect(labelsForFacets([facet]).length).toBeGreaterThan(0);
    }
  });

  it('de-duplicates across overlapping facets', () => {
    const labels = labelsForFacets(['lesbian', 'lesbian']);
    expect(labels).toEqual(['Lesbian']);
  });

  // An unknown facet must contribute nothing rather than widening the search —
  // searchMembers turns a wholly-unknown selection into a no-match.
  it('ignores unknown facet ids', () => {
    expect(labelsForFacets(['nonsense'])).toEqual([]);
    expect(labelsForFacets(['nonsense', 'gay'])).toEqual(['Gay']);
  });
});
