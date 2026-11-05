import { HttpException } from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SubprofilePublicReadService } from '../subprofiles/subprofile-public-read.service';
import { Lead } from './entities/lead.entity';
import { LeadPersonaService } from './lead-persona.service';

const LEAD_ID = 'e8100000-0000-4000-8000-000000000001';
const OTHER_LEAD_ID = 'e8100000-0000-4000-8000-000000000002';
const FIRST_PERSONA_ID = 'e8100000-0000-4000-8000-000000000011';
const SECOND_PERSONA_ID = 'e8100000-0000-4000-8000-000000000012';
const THIRD_PERSONA_ID = 'e8100000-0000-4000-8000-000000000013';
// Well-formed storage keys: `toImageUrl` drops anything that does not parse
// as one.
const AVATAR_KEY =
  'persona/e8100000-0000-4000-8000-000000000011/e8100000-0000-4000-8000-000000000031.jpg';
const SECOND_AVATAR_KEY =
  'persona/e8100000-0000-4000-8000-000000000012/e8100000-0000-4000-8000-000000000032.jpg';
const API_BASE_URL = 'https://api.example.test';

interface RefusalOutcome {
  code?: string;
  status?: number;
  leadId?: string;
  leadName?: string;
  publicState?: string;
}

async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as Omit<RefusalOutcome, 'status'>;
    return {
      code: body.code,
      status: httpError.getStatus(),
      leadId: body.leadId,
      leadName: body.leadName,
      publicState: body.publicState,
    };
  }
}

/** A persona row that also holds owner columns, so a test can prove they
 *  never reach a response. */
function buildPersona(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: FIRST_PERSONA_ID,
    handle: 'ana_poet',
    displayName: 'Ana Poet',
    kind: 'writer',
    avatarUrl: AVATAR_KEY,
    coverUrl: null,
    accent: 'coral',
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    removedAt: null,
    userId: 'e8100000-0000-4000-8000-000000000099',
    ...overrides,
  } as Subprofile;
}

describe('LeadPersonaService', () => {
  beforeAll(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  let manager: { find: jest.Mock; findOne: jest.Mock };
  let dataSource: { manager: typeof manager };
  let publicRead: {
    searchWallPersonas: jest.Mock;
    searchPersonasByHandlePrefix: jest.Mock;
  };
  let contentModeration: { stateFor: jest.Mock; statesFor: jest.Mock };
  let mediaCropService: { getMany: jest.Mock };
  let service: LeadPersonaService;
  let storedPersonas: Subprofile[];
  let storedLinkedLeads: Pick<Lead, 'id' | 'name' | 'linkedSubprofileId'>[];
  let personaForLink: Subprofile | null;
  let otherLeadForLink: Pick<Lead, 'id' | 'name'> | null;

  beforeEach(() => {
    storedPersonas = [];
    storedLinkedLeads = [];
    personaForLink = buildPersona();
    otherLeadForLink = null;
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === Lead) {
          return Promise.resolve(storedLinkedLeads);
        }
        return Promise.resolve(storedPersonas);
      }),
      findOne: jest.fn((entity: unknown) => {
        if (entity === Lead) {
          return Promise.resolve(otherLeadForLink);
        }
        return Promise.resolve(personaForLink);
      }),
    };
    dataSource = { manager };
    publicRead = {
      searchWallPersonas: jest.fn().mockResolvedValue([]),
      searchPersonasByHandlePrefix: jest.fn().mockResolvedValue([]),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
      statesFor: jest.fn().mockResolvedValue(new Map()),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    service = new LeadPersonaService(
      dataSource as unknown as DataSource,
      publicRead as unknown as SubprofilePublicReadService,
      contentModeration as unknown as ContentModerationService,
      mediaCropService as unknown as MediaCropService,
    );
  });

  describe('searchPersonas', () => {
    it('answers no items for a blank, repeated, missing or bare @ query and searches nothing', async () => {
      expect(await service.searchPersonas('  ')).toEqual({ items: [] });
      expect(await service.searchPersonas(['a', 'b'])).toEqual({ items: [] });
      expect(await service.searchPersonas(undefined)).toEqual({ items: [] });
      expect(await service.searchPersonas('@')).toEqual({ items: [] });
      expect(await service.searchPersonas('@  ')).toEqual({ items: [] });
      expect(publicRead.searchWallPersonas).not.toHaveBeenCalled();
      expect(publicRead.searchPersonasByHandlePrefix).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
      expect(mediaCropService.getMany).not.toHaveBeenCalled();
    });

    it('searches handles by prefix for an @ term', async () => {
      publicRead.searchPersonasByHandlePrefix.mockResolvedValue([
        buildPersona(),
      ]);

      const results = await service.searchPersonas('@Ana_');

      expect(publicRead.searchPersonasByHandlePrefix).toHaveBeenCalledTimes(1);
      expect(publicRead.searchPersonasByHandlePrefix).toHaveBeenCalledWith(
        'Ana_',
        20,
      );
      expect(publicRead.searchWallPersonas).not.toHaveBeenCalled();
      expect(results.items.map((result) => result.persona.id)).toEqual([
        FIRST_PERSONA_ID,
      ]);
    });

    it('searches the wall haystack for any other term, cut to 100 code points', async () => {
      await service.searchPersonas('🌈'.repeat(150));

      expect(publicRead.searchWallPersonas).toHaveBeenCalledTimes(1);
      expect(publicRead.searchWallPersonas).toHaveBeenCalledWith(
        '🌈'.repeat(100),
        20,
      );
      expect(publicRead.searchPersonasByHandlePrefix).not.toHaveBeenCalled();
    });

    it('answers no items for a NUL-only or @ NUL query and searches nothing', async () => {
      expect(await service.searchPersonas('\u0000')).toEqual({ items: [] });
      expect(await service.searchPersonas('@\u0000')).toEqual({ items: [] });
      expect(publicRead.searchWallPersonas).not.toHaveBeenCalled();
      expect(publicRead.searchPersonasByHandlePrefix).not.toHaveBeenCalled();
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('drops a NUL inside the term before searching', async () => {
      await service.searchPersonas('an\u0000a');

      expect(publicRead.searchWallPersonas).toHaveBeenCalledTimes(1);
      expect(publicRead.searchWallPersonas).toHaveBeenCalledWith('ana', 20);
      expect(publicRead.searchPersonasByHandlePrefix).not.toHaveBeenCalled();
    });

    it('marks each persona with the lead it is linked to in one read', async () => {
      publicRead.searchWallPersonas.mockResolvedValue([
        buildPersona(),
        buildPersona({
          id: SECOND_PERSONA_ID,
          handle: 'bo_sings',
          avatarUrl: SECOND_AVATAR_KEY,
        }),
        buildPersona({ id: THIRD_PERSONA_ID, avatarUrl: null }),
      ]);
      storedLinkedLeads = [
        {
          id: LEAD_ID,
          name: 'Bo Sings',
          linkedSubprofileId: SECOND_PERSONA_ID,
        },
      ];

      const results = await service.searchPersonas('ana');

      const leadFindCalls = (
        manager.find.mock.calls as [unknown, unknown][]
      ).filter(([entity]) => entity === Lead);
      expect(leadFindCalls).toHaveLength(1);
      expect(leadFindCalls[0]?.[1]).toEqual({
        where: {
          linkedSubprofileId: In([
            FIRST_PERSONA_ID,
            SECOND_PERSONA_ID,
            THIRD_PERSONA_ID,
          ]),
        },
        select: { id: true, name: true, linkedSubprofileId: true },
      });
      expect(results.items.map((result) => result.linkedLead)).toEqual([
        null,
        { id: LEAD_ID, name: 'Bo Sings' },
        null,
      ]);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([
        AVATAR_KEY,
        SECOND_AVATAR_KEY,
      ]);
    });

    it('answers persona fields only', async () => {
      publicRead.searchWallPersonas.mockResolvedValue([
        buildPersona(),
        buildPersona({ id: SECOND_PERSONA_ID, avatarUrl: null }),
      ]);

      const results = await service.searchPersonas('ana');

      for (const result of results.items) {
        expect(Object.keys(result.persona).sort()).toEqual(
          [
            'avatarCrop',
            'avatarUrl',
            'displayName',
            'handle',
            'id',
            'kind',
          ].sort(),
        );
      }
      expect(results.items[0]?.persona).toEqual({
        id: FIRST_PERSONA_ID,
        handle: 'ana_poet',
        displayName: 'Ana Poet',
        kind: 'writer',
        avatarUrl: `${API_BASE_URL}/files/${AVATAR_KEY}`,
        avatarCrop: null,
      });
    });
  });

  describe('loadPersonaRecords', () => {
    it('runs no query for no ids', async () => {
      const records = await service.loadPersonaRecords([]);

      expect(records.size).toBe(0);
      expect(manager.find).not.toHaveBeenCalled();
      expect(contentModeration.statesFor).not.toHaveBeenCalled();
      expect(mediaCropService.getMany).not.toHaveBeenCalled();
    });

    it('selects persona columns only and states each persona', async () => {
      storedPersonas = [
        buildPersona(),
        buildPersona({
          id: SECOND_PERSONA_ID,
          status: SubprofileStatus.Draft,
        }),
        // Published, open and kept: only the takedown hides it.
        buildPersona({ id: THIRD_PERSONA_ID }),
      ];
      contentModeration.statesFor.mockResolvedValue(
        new Map([[THIRD_PERSONA_ID, { hidden: true, removed: false }]]),
      );
      const subprofileIds = [
        FIRST_PERSONA_ID,
        SECOND_PERSONA_ID,
        THIRD_PERSONA_ID,
      ];

      const records = await service.loadPersonaRecords(subprofileIds);

      expect(manager.find).toHaveBeenCalledTimes(1);
      const [entity, options] = manager.find.mock.calls[0] as [
        unknown,
        { where: unknown; select: Record<string, boolean> },
      ];
      expect(entity).toBe(Subprofile);
      expect(options.where).toEqual({ id: In(subprofileIds) });
      expect(Object.keys(options.select)).toEqual([
        'id',
        'handle',
        'displayName',
        'kind',
        'avatarUrl',
        'status',
        'visibility',
        'removedAt',
      ]);
      expect(contentModeration.statesFor).toHaveBeenCalledTimes(1);
      expect(contentModeration.statesFor).toHaveBeenCalledWith(
        'subprofile',
        subprofileIds,
      );
      expect(
        subprofileIds.map(
          (subprofileId) => records.get(subprofileId)?.publicState,
        ),
      ).toEqual(['shown', 'draft', 'taken_down']);
      expect(records.get(FIRST_PERSONA_ID)?.row).toEqual({
        id: FIRST_PERSONA_ID,
        handle: 'ana_poet',
        displayName: 'Ana Poet',
        kind: 'writer',
        avatarUrl: AVATAR_KEY,
      });
      expect(mediaCropService.getMany).not.toHaveBeenCalled();
    });
  });

  describe('assertLinkable', () => {
    const assertLinkable = (subprofileId: string = FIRST_PERSONA_ID) =>
      service.assertLinkable(
        manager as unknown as EntityManager,
        LEAD_ID,
        subprofileId,
      );

    it('answers 404 LEAD_PERSONA_NOT_FOUND when no persona has the id', async () => {
      personaForLink = null;

      expect(await codeOf(assertLinkable())).toEqual(
        expect.objectContaining({
          code: 'LEAD_PERSONA_NOT_FOUND',
          status: 404,
        }),
      );
      expect(manager.findOne).toHaveBeenCalledWith(Subprofile, {
        where: { id: FIRST_PERSONA_ID },
        select: { id: true, status: true, visibility: true, removedAt: true },
        lock: { mode: 'pessimistic_read' },
      });
      expect(manager.findOne).not.toHaveBeenCalledWith(Lead, expect.anything());
      expect(contentModeration.stateFor).not.toHaveBeenCalled();
    });

    it('answers 409 LEAD_PERSONA_TAKEN with the other lead before the listing check', async () => {
      personaForLink = buildPersona({ status: SubprofileStatus.Draft });
      otherLeadForLink = { id: OTHER_LEAD_ID, name: 'Ana Booking' };

      expect(await codeOf(assertLinkable())).toEqual({
        code: 'LEAD_PERSONA_TAKEN',
        status: 409,
        leadId: OTHER_LEAD_ID,
        leadName: 'Ana Booking',
        publicState: undefined,
      });
      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { linkedSubprofileId: FIRST_PERSONA_ID, id: Not(LEAD_ID) },
        select: { id: true, name: true },
      });
      expect(contentModeration.stateFor).not.toHaveBeenCalled();
    });

    it('answers 409 LEAD_PERSONA_NOT_LISTED with the state', async () => {
      personaForLink = buildPersona({ status: SubprofileStatus.Draft });

      expect(await codeOf(assertLinkable())).toEqual(
        expect.objectContaining({
          code: 'LEAD_PERSONA_NOT_LISTED',
          status: 409,
          publicState: 'draft',
        }),
      );

      personaForLink = buildPersona();
      contentModeration.stateFor.mockResolvedValue({
        hidden: true,
        removed: false,
      });

      expect(await codeOf(assertLinkable())).toEqual(
        expect.objectContaining({
          code: 'LEAD_PERSONA_NOT_LISTED',
          status: 409,
          publicState: 'taken_down',
        }),
      );
      expect(contentModeration.stateFor).toHaveBeenCalledWith(
        'subprofile',
        FIRST_PERSONA_ID,
      );
    });

    it('passes a shown persona nobody else links', async () => {
      await expect(assertLinkable()).resolves.toBeUndefined();
      expect(manager.findOne).toHaveBeenCalledTimes(2);
      expect(contentModeration.stateFor).toHaveBeenCalledTimes(1);
    });
  });
});
