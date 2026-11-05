import { HttpException } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  FindOperator,
  In,
  Not,
  QueryFailedError,
} from 'typeorm';
import {
  resetImageUrlBaseForTesting,
  setImageUrlBase,
} from '../common/image-url';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import {
  decodeLeadCursor,
  encodeLeadCursor,
  LEAD_CURSOR_UPDATED_AT_SQL,
} from './lead-cursor';
import { LeadPersonaService } from './lead-persona.service';
import type { LeadCaller, LeadPersonaRecord } from './lead-response';
import {
  LEAD_AFTER_CURSOR_SQL,
  LEAD_DUE_ON_SQL,
  LEAD_DUE_RANK_SQL,
  LEAD_ENTRY_STATS_SQL,
  LEAD_IS_DUE_SQL,
  LEAD_SEARCH_SQL,
  LeadsService,
  LOCK_LEADS_SQL,
} from './leads.service';

const ADMIN_ID = 'd7400000-0000-4000-8000-000000000001';
const HOLDER_ID = 'd7400000-0000-4000-8000-000000000002';
const LEAD_ID = 'd7400000-0000-4000-8000-000000000011';
const OTHER_LEAD_ID = 'd7400000-0000-4000-8000-000000000012';
const PERSONA_ID = 'd7400000-0000-4000-8000-000000000021';
const SECOND_PERSONA_ID = 'd7400000-0000-4000-8000-000000000022';
const ENTRY_ID = 'd7400000-0000-4000-8000-000000000031';
const SECOND_ENTRY_ID = 'd7400000-0000-4000-8000-000000000032';
const THIRD_ENTRY_ID = 'd7400000-0000-4000-8000-000000000033';
const FOURTH_ENTRY_ID = 'd7400000-0000-4000-8000-000000000034';
// Well-formed storage keys: `toImageUrl` drops anything that does not parse
// as one.
const PERSONA_AVATAR_KEY =
  'persona/d7400000-0000-4000-8000-000000000021/d7400000-0000-4000-8000-000000000041.jpg';
const SECOND_PERSONA_AVATAR_KEY =
  'persona/d7400000-0000-4000-8000-000000000022/d7400000-0000-4000-8000-000000000042.jpg';
const PROFILE_AVATAR_KEY =
  'persona/d7400000-0000-4000-8000-000000000001/d7400000-0000-4000-8000-000000000043.jpg';
const API_BASE_URL = 'https://api.example.test';

const ADMIN: LeadCaller = { userId: ADMIN_ID, role: UserRole.Admin };
const GRANT_HOLDER: LeadCaller = { userId: HOLDER_ID, role: UserRole.Member };

interface RefusalOutcome {
  code?: string;
  status?: number;
  body?: Record<string, unknown>;
}

async function codeOf(promise: Promise<unknown>): Promise<RefusalOutcome> {
  try {
    await promise;
    return {};
  } catch (error) {
    const httpError = error as HttpException;
    const body = httpError.getResponse() as Record<string, unknown>;
    return {
      code: body.code as string | undefined,
      status: httpError.getStatus(),
      body,
    };
  }
}

/** The global call order of one call of a mock. Throws when that call never
 *  happened, so an order assertion can not pass on a missing call. */
function callOrderOf(mockFunction: jest.Mock, callIndex = 0): number {
  const callOrder = mockFunction.mock.invocationCallOrder[callIndex];
  if (callOrder === undefined) {
    throw new Error(`Call ${callIndex} of the mock never happened`);
  }
  return callOrder;
}

/** The element at `index`. Throws when it is missing, so an assertion can
 *  not pass on an absent row or builder. */
function elementAt<Element>(
  elements: readonly Element[],
  index: number,
): Element {
  const element = elements[index];
  if (element === undefined) {
    throw new Error(`No element at index ${index}`);
  }
  return element;
}

/** A v4 uuid for the lead at a list position. */
function leadIdAt(position: number): string {
  return `d7400000-0000-4000-8000-${String(position).padStart(12, '0')}`;
}

function buildLead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: LEAD_ID,
    name: 'Ana',
    type: 'dj',
    stage: 'to_contact',
    location: null,
    email: null,
    phone: null,
    links: [],
    followUpOn: null,
    linkedSubprofileId: null,
    createdById: ADMIN_ID,
    createdAt: new Date('2026-06-01T09:00:00.000Z'),
    updatedAt: new Date('2026-06-02T09:00:00.000Z'),
    ...overrides,
  };
}

function buildEntry(overrides: Partial<LeadEntry> = {}): LeadEntry {
  return {
    id: ENTRY_ID,
    leadId: LEAD_ID,
    kind: 'note',
    body: 'hi',
    fromStage: null,
    toStage: null,
    subprofileId: null,
    authorId: ADMIN_ID,
    createdAt: new Date('2026-06-03T09:00:00.000Z'),
    editedAt: null,
    ...overrides,
  };
}

function buildPersonaRecord(
  id: string,
  avatarUrl: string | null,
): LeadPersonaRecord {
  return {
    row: {
      id,
      handle: 'ana-dj',
      displayName: 'Ana DJ',
      kind: 'dj',
      avatarUrl,
    } as LeadPersonaRecord['row'],
    publicState: 'shown',
  };
}

function uniqueViolation(constraint: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505', constraint }),
  );
}

interface QueryBuilderStub {
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  setParameters: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  limit: jest.Mock;
  groupBy: jest.Mock;
  getRawAndEntities: jest.Mock;
  getRawMany: jest.Mock;
  getCount: jest.Mock;
}

describe('LeadsService', () => {
  beforeAll(() => {
    setImageUrlBase(API_BASE_URL);
  });

  afterAll(() => {
    resetImageUrlBaseForTesting();
  });

  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    query: jest.Mock;
    getRepository: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let auditRepository: { create: jest.Mock; save: jest.Mock };
  let dataSource: { transaction: jest.Mock; manager: typeof manager };
  let leadPersonas: {
    loadPersonaRecords: jest.Mock;
    assertLinkable: jest.Mock;
  };
  let mediaCropService: { getMany: jest.Mock };
  let service: LeadsService;
  let builders: QueryBuilderStub[];
  let pageLeads: Lead[];
  let pageRaw: Record<string, unknown>[];
  let stageCountRows: { stage: string; count: string }[];
  let dueCountValue: number;
  let storedLead: Lead | null;
  let storedEntries: LeadEntry[];
  let storedProfiles: Profile[];
  let otherLeads: Lead[];
  let emailHolder: Pick<Lead, 'id' | 'name'> | null;
  let personaHolder: Pick<Lead, 'id' | 'name'> | null;

  function buildQueryBuilder(): QueryBuilderStub {
    const builder = {} as QueryBuilderStub;
    const chainable = [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'setParameter',
      'setParameters',
      'orderBy',
      'addOrderBy',
      'limit',
      'groupBy',
    ] as const;
    for (const method of chainable) {
      builder[method] = jest.fn(() => builder);
    }
    builder.getRawAndEntities = jest.fn(() =>
      Promise.resolve({ raw: pageRaw, entities: pageLeads }),
    );
    builder.getRawMany = jest.fn(() => Promise.resolve(stageCountRows));
    builder.getCount = jest.fn(() => Promise.resolve(dueCountValue));
    return builder;
  }

  /** The query builder created by call `index` of `createQueryBuilder`.
   *  Throws when that call never happened. */
  function builderAt(index: number): QueryBuilderStub {
    return elementAt(builders, index);
  }

  /** The calls of `manager.save` whose target is the given entity. */
  function savedRowsOf(entity: unknown): Record<string, unknown>[] {
    return manager.save.mock.calls
      .filter((call: unknown[]) => call[0] === entity)
      .map((call: unknown[]) => call[1] as Record<string, unknown>);
  }

  /** The options of every `manager.find` call on the given entity. */
  function findOptionsOf(entity: unknown): Record<string, unknown>[] {
    return manager.find.mock.calls
      .filter((call: unknown[]) => call[0] === entity)
      .map((call: unknown[]) => call[1] as Record<string, unknown>);
  }

  beforeEach(() => {
    builders = [];
    pageLeads = [];
    pageRaw = [];
    stageCountRows = [];
    dueCountValue = 0;
    storedLead = buildLead();
    storedEntries = [];
    storedProfiles = [];
    otherLeads = [];
    emailHolder = null;
    personaHolder = null;
    auditRepository = {
      create: jest.fn((row: object) => row),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    manager = {
      find: jest.fn((entity: unknown) => {
        if (entity === LeadEntry) return Promise.resolve(storedEntries);
        if (entity === Profile) return Promise.resolve(storedProfiles);
        if (entity === Lead) return Promise.resolve(otherLeads);
        return Promise.resolve([]);
      }),
      findOne: jest.fn(
        (entity: unknown, options: { where?: Record<string, unknown> }) => {
          if (entity !== Lead) return Promise.resolve(null);
          const where = options.where ?? {};
          if ('email' in where) return Promise.resolve(emailHolder);
          if ('linkedSubprofileId' in where) {
            return Promise.resolve(personaHolder);
          }
          return Promise.resolve(storedLead);
        },
      ),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((entity: unknown, row: object) =>
        Promise.resolve({
          ...row,
          id: entity === Lead ? LEAD_ID : ENTRY_ID,
        }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      delete: jest.fn().mockResolvedValue({ affected: 1 }),
      query: jest.fn().mockResolvedValue([]),
      getRepository: jest.fn(() => auditRepository),
      createQueryBuilder: jest.fn(() => {
        const builder = buildQueryBuilder();
        builders.push(builder);
        return builder;
      }),
    };
    dataSource = {
      transaction: jest.fn((work: (inner: EntityManager) => unknown) =>
        Promise.resolve(work(manager as unknown as EntityManager)),
      ),
      manager,
    };
    leadPersonas = {
      loadPersonaRecords: jest.fn().mockResolvedValue(new Map()),
      assertLinkable: jest.fn().mockResolvedValue(undefined),
    };
    mediaCropService = { getMany: jest.fn().mockResolvedValue(new Map()) };
    service = new LeadsService(
      dataSource as unknown as DataSource,
      leadPersonas as unknown as LeadPersonaService,
      mediaCropService as unknown as MediaCropService,
    );
  });

  describe('listLeads', () => {
    it('binds the Lisbon day and orders due follow-ups first', async () => {
      await service.listLeads({}, new Date('2026-07-01T23:30:00Z'));

      expect(manager.createQueryBuilder).toHaveBeenNthCalledWith(
        1,
        Lead,
        'lead',
      );
      const pageBuilder = builderAt(0);
      expect(pageBuilder.setParameter).toHaveBeenCalledWith(
        'today',
        '2026-07-02',
      );
      expect(pageBuilder.addSelect.mock.calls).toEqual([
        [LEAD_DUE_RANK_SQL, 'due_rank'],
        [LEAD_DUE_ON_SQL, 'due_on'],
        [LEAD_CURSOR_UPDATED_AT_SQL, 'cursor_updated_at'],
      ]);
      expect(pageBuilder.orderBy).toHaveBeenCalledWith('due_rank', 'ASC');
      expect(pageBuilder.addOrderBy.mock.calls).toEqual([
        ['due_on', 'ASC', 'NULLS LAST'],
        ['lead.updatedAt', 'DESC'],
        ['lead.id', 'DESC'],
      ]);
      expect(pageBuilder.limit).toHaveBeenCalledWith(51);
      expect(pageBuilder.andWhere).not.toHaveBeenCalled();
    });

    it('answers a next cursor from row 50 when a 51st row exists', async () => {
      const buildPage = (rowCount: number): void => {
        pageLeads = Array.from({ length: rowCount }, (_unused, position) =>
          buildLead({
            id: leadIdAt(position + 1),
            stage: 'contacted',
            followUpOn: '2026-06-30',
          }),
        );
        pageRaw = pageLeads.map((_lead, position) => ({
          due_rank: 0,
          due_on: '2026-06-30',
          cursor_updated_at: `2026-07-01T10:00:${String(position).padStart(2, '0')}.123456Z`,
        }));
      };

      buildPage(51);
      const fullPage = await service.listLeads(
        {},
        new Date('2026-07-01T23:30:00Z'),
      );

      expect(fullPage.items).toHaveLength(50);
      expect(fullPage.nextCursor).not.toBeNull();
      expect(decodeLeadCursor(fullPage.nextCursor as string)).toEqual({
        today: '2026-07-02',
        dueRank: 0,
        dueOn: '2026-06-30',
        updatedAt: '2026-07-01T10:00:49.123456Z',
        leadId: leadIdAt(50),
      });

      buildPage(50);
      const lastPage = await service.listLeads(
        {},
        new Date('2026-07-01T23:30:00Z'),
      );

      expect(lastPage.items).toHaveLength(50);
      expect(lastPage.nextCursor).toBeNull();
    });

    it('continues the cursor day after Lisbon midnight', async () => {
      const cursor = encodeLeadCursor({
        today: '2026-07-01',
        dueRank: 0,
        dueOn: '2026-06-30',
        updatedAt: '2026-07-01T09:00:00.000001Z',
        leadId: OTHER_LEAD_ID,
      });

      await service.listLeads({ cursor }, new Date('2026-07-02T08:00:00Z'));

      const pageBuilder = builderAt(0);
      expect(pageBuilder.setParameter).toHaveBeenCalledWith(
        'today',
        '2026-07-01',
      );
      expect(pageBuilder.andWhere).toHaveBeenCalledWith(LEAD_AFTER_CURSOR_SQL, {
        cursorRank: 0,
        cursorDueOn: '2026-06-30',
        cursorUpdatedAt: '2026-07-01T09:00:00.000001Z',
        cursorId: OTHER_LEAD_ID,
      });
    });

    it('refuses bad filters before any query', async () => {
      expect(await codeOf(service.listLeads({ stage: 'x' }))).toMatchObject({
        code: 'LEAD_STAGE_INVALID',
        status: 400,
      });
      expect(await codeOf(service.listLeads({ cursor: 'bad' }))).toMatchObject({
        code: 'LEAD_CURSOR_INVALID',
        status: 400,
      });
      expect(manager.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('narrows to due leads only for due=true', async () => {
      await service.listLeads({ due: 'true' });

      expect(builderAt(0).andWhere).toHaveBeenCalledWith(LEAD_IS_DUE_SQL);
      expect(builderAt(1).andWhere).not.toHaveBeenCalledWith(LEAD_IS_DUE_SQL);

      builders = [];
      await service.listLeads({ due: 'TRUE' });

      expect(builderAt(0).andWhere).not.toHaveBeenCalledWith(LEAD_IS_DUE_SQL);
    });

    it('searches name, email and link text with escaped wildcards', async () => {
      await service.listLeads({ q: ' 50%_off\\ ' });

      expect(builderAt(0).andWhere).toHaveBeenCalledWith(LEAD_SEARCH_SQL, {
        term: '%50\\%\\_off\\\\%',
      });
    });

    it('counts every stage for q and type only', async () => {
      stageCountRows = [{ stage: 'contacted', count: '2' }];

      const page = await service.listLeads({
        q: 'ana',
        type: 'dj',
        stage: 'contacted',
        due: 'true',
      });

      expect(builders).toHaveLength(2);
      const countBuilder = builderAt(1);
      expect(countBuilder.andWhere.mock.calls).toEqual([
        [LEAD_SEARCH_SQL, { term: '%ana%' }],
        ['lead.type = :type', { type: 'dj' }],
      ]);
      expect(countBuilder.select).toHaveBeenCalledWith('lead.stage', 'stage');
      expect(countBuilder.addSelect).toHaveBeenCalledWith(
        'COUNT(*)::int',
        'count',
      );
      expect(countBuilder.groupBy).toHaveBeenCalledWith('lead.stage');
      expect(countBuilder.getRawMany).toHaveBeenCalledTimes(1);
      expect(page.stageCounts).toEqual({
        to_contact: 0,
        contacted: 2,
        in_talks: 0,
        on_board: 0,
        not_now: 0,
      });
      expect(page.totalCount).toBe(2);

      const pageBuilder = builderAt(0);
      expect(pageBuilder.andWhere).toHaveBeenCalledWith('lead.stage = :stage', {
        stage: 'contacted',
      });
      expect(pageBuilder.andWhere).toHaveBeenCalledWith(LEAD_IS_DUE_SQL);
    });

    it('reads note counts, last entries and linked personas in one batch each', async () => {
      const linkedLead = buildLead({
        id: LEAD_ID,
        linkedSubprofileId: PERSONA_ID,
      });
      const plainLead = buildLead({ id: OTHER_LEAD_ID });
      pageLeads = [linkedLead, plainLead];
      pageRaw = [
        { due_rank: 1, cursor_updated_at: '2026-06-02T09:00:00.000000Z' },
        { due_rank: 1, cursor_updated_at: '2026-06-02T09:00:00.000000Z' },
      ];
      manager.query.mockResolvedValue([
        {
          lead_id: LEAD_ID,
          note_count: 3,
          last_entry_at: new Date('2026-06-05T10:00:00.000Z'),
        },
      ]);
      leadPersonas.loadPersonaRecords.mockResolvedValue(
        new Map([
          [PERSONA_ID, buildPersonaRecord(PERSONA_ID, PERSONA_AVATAR_KEY)],
        ]),
      );

      const page = await service.listLeads(
        {},
        new Date('2026-07-01T10:00:00Z'),
      );

      expect(manager.query).toHaveBeenCalledTimes(1);
      expect(manager.query).toHaveBeenCalledWith(LEAD_ENTRY_STATS_SQL, [
        [LEAD_ID, OTHER_LEAD_ID],
      ]);
      expect(leadPersonas.loadPersonaRecords).toHaveBeenCalledTimes(1);
      expect(leadPersonas.loadPersonaRecords).toHaveBeenCalledWith([
        PERSONA_ID,
      ]);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([
        PERSONA_AVATAR_KEY,
      ]);
      expect(page.items[0]).toMatchObject({
        id: LEAD_ID,
        noteCount: 3,
        lastEntryAt: '2026-06-05T10:00:00.000Z',
        linkedPersona: {
          id: PERSONA_ID,
          publicState: 'shown',
          avatarUrl: `${API_BASE_URL}/files/${PERSONA_AVATAR_KEY}`,
        },
      });
      expect(page.items[1]).toMatchObject({
        id: OTHER_LEAD_ID,
        noteCount: 0,
        lastEntryAt: plainLead.createdAt.toISOString(),
        linkedPersona: null,
      });
    });
  });

  describe('dueCount', () => {
    it('reads the Lisbon day across the summer offset', async () => {
      dueCountValue = 4;

      const beforeMidnight = await service.dueCount(
        new Date('2026-07-01T22:59:59Z'),
      );
      const afterMidnight = await service.dueCount(
        new Date('2026-07-01T23:00:00Z'),
      );

      expect(builderAt(0).setParameter).toHaveBeenCalledWith(
        'today',
        '2026-07-01',
      );
      expect(builderAt(1).setParameter).toHaveBeenCalledWith(
        'today',
        '2026-07-02',
      );
      expect(builderAt(0).where).toHaveBeenCalledWith(LEAD_IS_DUE_SQL);
      expect(beforeMidnight).toEqual({ count: 4 });
      expect(afterMidnight).toEqual({ count: 4 });
    });
  });

  describe('createLead', () => {
    it('runs the field checks before opening a transaction', async () => {
      expect(
        await codeOf(service.createLead(ADMIN, { name: '' })),
      ).toMatchObject({ code: 'LEAD_NAME_REQUIRED', status: 400 });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses an email another lead holds, after the table lock', async () => {
      emailHolder = { id: OTHER_LEAD_ID, name: 'Other lead' };

      const outcome = await codeOf(
        service.createLead(ADMIN, {
          name: 'Ana',
          type: 'dj',
          email: ' Ana@Example.org ',
        }),
      );

      expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { email: 'ana@example.org' },
        select: { id: true, name: true },
      });
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(outcome.status).toBe(409);
      expect(outcome.body).toEqual({
        statusCode: 409,
        message: expect.any(String) as string,
        code: 'LEAD_EMAIL_TAKEN',
        leadId: OTHER_LEAD_ID,
        leadName: 'Other lead',
      });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('refuses the first clashing link in submitted order with its index', async () => {
      otherLeads = [
        buildLead({
          id: OTHER_LEAD_ID,
          name: 'Other lead',
          links: ['https://www.instagram.com/ana/'],
        }),
      ];

      const outcome = await codeOf(
        service.createLead(ADMIN, {
          name: 'Ana',
          type: 'dj',
          links: ['https://x.org', 'http://instagram.com/ana'],
        }),
      );

      expect(outcome).toMatchObject({
        code: 'LEAD_LINK_TAKEN',
        status: 409,
        body: { leadId: OTHER_LEAD_ID, leadName: 'Other lead', index: 1 },
      });
      const scanOptions = elementAt(findOptionsOf(Lead), 0);
      expect(scanOptions.select).toEqual({ id: true, name: true, links: true });
      const scanWhere = scanOptions.where as Record<string, unknown>;
      expect(Object.keys(scanWhere)).toEqual(['links']);
      const linksFilter = scanWhere.links as FindOperator<unknown>;
      expect(linksFilter).toBeInstanceOf(FindOperator);
      expect(linksFilter.getSql?.('"lead"."links"')).toBe(
        `"lead"."links" <> '[]'::jsonb`,
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('writes the lead, the created entry, then the first note', async () => {
      const lead = await service.createLead(ADMIN, {
        name: ' Ana ',
        type: 'dj',
        stage: 'contacted',
        links: ['https://Example.org/Press/'],
        note: ' hi ',
      });

      expect(manager.save.mock.calls.map((call: unknown[]) => call[0])).toEqual(
        [Lead, LeadEntry, LeadEntry],
      );
      expect(savedRowsOf(Lead)[0]).toMatchObject({
        name: 'Ana',
        type: 'dj',
        stage: 'contacted',
        links: ['https://Example.org/Press/'],
        createdById: ADMIN_ID,
      });
      expect(savedRowsOf(LeadEntry)).toEqual([
        {
          leadId: LEAD_ID,
          kind: 'created',
          toStage: 'contacted',
          authorId: ADMIN_ID,
        },
        { leadId: LEAD_ID, kind: 'note', body: 'hi', authorId: ADMIN_ID },
      ]);
      expect(lead.id).toBe(LEAD_ID);
      // No email was sent, so the one lead read is getLead's, after the note.
      expect(manager.findOne).toHaveBeenCalledTimes(1);
      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { id: LEAD_ID },
      });
      expect(callOrderOf(manager.save, 2)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
    });

    it('answers 409 LEAD_EMAIL_TAKEN when the unique index fires', async () => {
      manager.save.mockRejectedValueOnce(uniqueViolation('UQ_leads_email'));
      manager.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: OTHER_LEAD_ID, name: 'Other lead' });

      const outcome = await codeOf(
        service.createLead(ADMIN, {
          name: 'Ana',
          type: 'dj',
          email: 'ana@example.org',
        }),
      );

      expect(outcome).toMatchObject({
        code: 'LEAD_EMAIL_TAKEN',
        status: 409,
        body: { leadId: OTHER_LEAD_ID, leadName: 'Other lead' },
      });
      expect(JSON.stringify(outcome.body)).not.toContain('ana@example.org');
    });

    it('answers 400 LEAD_NAME_REQUIRED when the name CHECK fires', async () => {
      manager.save.mockRejectedValueOnce(
        new QueryFailedError(
          'INSERT',
          [],
          Object.assign(new Error('check violation'), {
            code: '23514',
            constraint: 'CHK_leads_name',
          }),
        ),
      );

      expect(
        await codeOf(service.createLead(ADMIN, { name: 'Ana', type: 'dj' })),
      ).toMatchObject({ code: 'LEAD_NAME_REQUIRED', status: 400 });
    });

    it('rethrows an unrelated driver error unchanged', async () => {
      const serializationFailure = new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('could not serialize access'), {
          code: '40001',
        }),
      );
      manager.save.mockRejectedValueOnce(serializationFailure);

      await expect(
        service.createLead(ADMIN, { name: 'Ana', type: 'dj' }),
      ).rejects.toBe(serializationFailure);
      expect(manager.findOne).not.toHaveBeenCalled();
    });
  });

  describe('getLead', () => {
    it('answers 404 LEAD_NOT_FOUND for a malformed id before any query', async () => {
      expect(await codeOf(service.getLead('not-a-uuid', ADMIN))).toEqual(
        expect.objectContaining({ code: 'LEAD_NOT_FOUND', status: 404 }),
      );
      expect(manager.findOne).not.toHaveBeenCalled();
    });

    it('answers 404 LEAD_NOT_FOUND for an unknown id', async () => {
      storedLead = null;

      expect(await codeOf(service.getLead(LEAD_ID, ADMIN))).toEqual(
        expect.objectContaining({ code: 'LEAD_NOT_FOUND', status: 404 }),
      );
      expect(manager.find).not.toHaveBeenCalled();
    });

    it('lists entries newest first with author, persona and canEdit', async () => {
      storedEntries = [
        buildEntry({ id: ENTRY_ID, authorId: ADMIN_ID }),
        buildEntry({ id: SECOND_ENTRY_ID, authorId: HOLDER_ID }),
        buildEntry({ id: THIRD_ENTRY_ID, authorId: null }),
        buildEntry({
          id: FOURTH_ENTRY_ID,
          kind: 'created',
          body: null,
          toStage: 'to_contact',
          authorId: ADMIN_ID,
        }),
      ];
      storedProfiles = [
        {
          userId: ADMIN_ID,
          firstName: 'Ada',
          lastName: 'Admin',
          avatarUrl: null,
        } as Profile,
        {
          userId: HOLDER_ID,
          firstName: 'Hal',
          lastName: 'Holder',
          avatarUrl: null,
        } as Profile,
      ];

      const adminView = await service.getLead(LEAD_ID, ADMIN);

      expect(manager.find).toHaveBeenCalledWith(LeadEntry, {
        where: { leadId: LEAD_ID },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      const profileReads = findOptionsOf(Profile);
      expect(profileReads).toEqual([
        {
          where: { userId: In([ADMIN_ID, HOLDER_ID]) },
          select: {
            userId: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
          },
        },
      ]);
      expect(adminView.entries.map((entry) => entry.canEdit)).toEqual([
        true,
        true,
        true,
        false,
      ]);
      expect(elementAt(adminView.entries, 0).author).toMatchObject({
        id: ADMIN_ID,
        displayName: 'Ada Admin',
      });
      expect(elementAt(adminView.entries, 2).author).toBeNull();

      const holderView = await service.getLead(LEAD_ID, GRANT_HOLDER);

      expect(holderView.entries.map((entry) => entry.canEdit)).toEqual([
        false,
        true,
        false,
        false,
      ]);
    });

    it('reads personas, takedowns and crops in one batch each', async () => {
      storedLead = buildLead({ linkedSubprofileId: PERSONA_ID });
      storedEntries = [
        buildEntry({
          id: ENTRY_ID,
          kind: 'persona_linked',
          body: null,
          subprofileId: SECOND_PERSONA_ID,
        }),
        buildEntry({
          id: SECOND_ENTRY_ID,
          kind: 'persona_unlinked',
          body: null,
          subprofileId: null,
        }),
      ];
      storedProfiles = [
        {
          userId: ADMIN_ID,
          firstName: 'Ada',
          lastName: 'Admin',
          avatarUrl: PROFILE_AVATAR_KEY,
        } as Profile,
      ];
      leadPersonas.loadPersonaRecords.mockResolvedValue(
        new Map([
          [PERSONA_ID, buildPersonaRecord(PERSONA_ID, PERSONA_AVATAR_KEY)],
          [
            SECOND_PERSONA_ID,
            buildPersonaRecord(SECOND_PERSONA_ID, SECOND_PERSONA_AVATAR_KEY),
          ],
        ]),
      );

      const lead = await service.getLead(LEAD_ID, ADMIN);

      expect(leadPersonas.loadPersonaRecords).toHaveBeenCalledTimes(1);
      expect(leadPersonas.loadPersonaRecords).toHaveBeenCalledWith([
        PERSONA_ID,
        SECOND_PERSONA_ID,
      ]);
      expect(mediaCropService.getMany).toHaveBeenCalledTimes(1);
      expect(mediaCropService.getMany).toHaveBeenCalledWith([
        PERSONA_AVATAR_KEY,
        SECOND_PERSONA_AVATAR_KEY,
        PROFILE_AVATAR_KEY,
      ]);
      expect(lead.linkedPersona).toMatchObject({
        id: PERSONA_ID,
        publicState: 'shown',
      });
      expect(elementAt(lead.entries, 0).persona).toMatchObject({
        id: SECOND_PERSONA_ID,
      });
      expect(elementAt(lead.entries, 0).persona).not.toHaveProperty(
        'publicState',
      );
      expect(elementAt(lead.entries, 1).persona).toBeNull();
    });
  });

  describe('updateLead', () => {
    it('answers 404 for a malformed id and 400 LEAD_PERSONA_NOT_FOUND for a malformed persona id before the transaction', async () => {
      expect(
        await codeOf(service.updateLead('not-a-uuid', ADMIN, {})),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(
        await codeOf(
          service.updateLead(LEAD_ID, ADMIN, {
            linkedSubprofileId: 'not-a-uuid',
          }),
        ),
      ).toMatchObject({ code: 'LEAD_PERSONA_NOT_FOUND', status: 400 });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('locks the table and reads the lead for update', async () => {
      await service.updateLead(LEAD_ID, ADMIN, { name: 'New name' });

      expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
      expect(manager.findOne).toHaveBeenNthCalledWith(1, Lead, {
        where: { id: LEAD_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.update).toHaveBeenCalledWith(Lead, LEAD_ID, {
        name: 'New name',
      });

      manager.update.mockClear();
      storedLead = null;

      expect(
        await codeOf(service.updateLead(LEAD_ID, ADMIN, { name: 'New name' })),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('writes nothing when every value matches', async () => {
      storedLead = buildLead({
        name: 'Ana',
        stage: 'in_talks',
        links: ['https://example.org'],
        linkedSubprofileId: PERSONA_ID,
      });

      await service.updateLead(LEAD_ID, ADMIN, {
        name: ' Ana ',
        stage: 'in_talks',
        links: ['https://example.org'],
        linkedSubprofileId: PERSONA_ID.toUpperCase(),
      });

      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
      expect(auditRepository.save).not.toHaveBeenCalled();
      expect(leadPersonas.assertLinkable).not.toHaveBeenCalled();
    });

    it('clears location, email and phone sent blank', async () => {
      storedLead = buildLead({
        location: 'Lisbon',
        email: 'ana@example.org',
        phone: '+351 900 000 000',
      });

      await service.updateLead(LEAD_ID, ADMIN, {
        location: '  ',
        email: '',
        phone: ' ',
      });

      expect(manager.update).toHaveBeenCalledWith(Lead, LEAD_ID, {
        location: null,
        email: null,
        phone: null,
      });
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('checks a changed email and sent links against other leads only', async () => {
      storedLead = buildLead({ email: 'ana@example.org' });

      await service.updateLead(LEAD_ID, ADMIN, {
        email: 'new@example.org',
        links: ['https://example.org/new'],
      });

      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { email: 'new@example.org', id: Not(LEAD_ID) },
        select: { id: true, name: true },
      });
      const scanOptions = elementAt(findOptionsOf(Lead), 0);
      const scanWhere = scanOptions.where as Record<string, unknown>;
      expect(scanWhere.id).toEqual(Not(LEAD_ID));
      expect(scanWhere.links).toBeInstanceOf(FindOperator);

      manager.findOne.mockClear();
      await service.updateLead(LEAD_ID, ADMIN, { email: ' ANA@example.org ' });

      const emailLookups = manager.findOne.mock.calls.filter(
        (call: unknown[]) =>
          'email' in
          ((call[1] as { where?: Record<string, unknown> }).where ?? {}),
      );
      expect(emailLookups).toHaveLength(0);
    });

    it('writes stage, unlink and link entries and two audit rows in order on a persona swap with a stage change', async () => {
      storedLead = buildLead({
        stage: 'in_talks',
        linkedSubprofileId: PERSONA_ID,
      });

      await service.updateLead(LEAD_ID, ADMIN, {
        stage: 'on_board',
        linkedSubprofileId: SECOND_PERSONA_ID,
      });

      expect(leadPersonas.assertLinkable).toHaveBeenCalledWith(
        manager,
        LEAD_ID,
        SECOND_PERSONA_ID,
      );
      expect(callOrderOf(leadPersonas.assertLinkable)).toBeLessThan(
        callOrderOf(manager.update),
      );
      expect(manager.update).toHaveBeenCalledWith(Lead, LEAD_ID, {
        stage: 'on_board',
        linkedSubprofileId: SECOND_PERSONA_ID,
      });
      expect(savedRowsOf(LeadEntry)).toEqual([
        {
          leadId: LEAD_ID,
          kind: 'stage_changed',
          fromStage: 'in_talks',
          toStage: 'on_board',
          authorId: ADMIN_ID,
        },
        {
          leadId: LEAD_ID,
          kind: 'persona_unlinked',
          subprofileId: PERSONA_ID,
          authorId: ADMIN_ID,
        },
        {
          leadId: LEAD_ID,
          kind: 'persona_linked',
          subprofileId: SECOND_PERSONA_ID,
          authorId: ADMIN_ID,
        },
      ]);
      expect(auditRepository.save.mock.calls).toEqual([
        [
          expect.objectContaining({
            action: 'lead_persona_unlinked',
            actorId: ADMIN_ID,
            note: `lead:${LEAD_ID} persona:${PERSONA_ID}`,
          }),
        ],
        [
          expect.objectContaining({
            action: 'lead_persona_linked',
            actorId: ADMIN_ID,
            note: `lead:${LEAD_ID} persona:${SECOND_PERSONA_ID}`,
          }),
        ],
      ]);
    });

    it('unlinks with null and writes one entry and one audit row', async () => {
      storedLead = buildLead({ linkedSubprofileId: PERSONA_ID });

      await service.updateLead(LEAD_ID, ADMIN, { linkedSubprofileId: null });

      expect(leadPersonas.assertLinkable).not.toHaveBeenCalled();
      expect(manager.update).toHaveBeenCalledWith(Lead, LEAD_ID, {
        linkedSubprofileId: null,
      });
      expect(savedRowsOf(LeadEntry)).toEqual([
        {
          leadId: LEAD_ID,
          kind: 'persona_unlinked',
          subprofileId: PERSONA_ID,
          authorId: ADMIN_ID,
        },
      ]);
      expect(auditRepository.save).toHaveBeenCalledTimes(1);
      expect(auditRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'lead_persona_unlinked',
          note: `lead:${LEAD_ID} persona:${PERSONA_ID}`,
        }),
      );
    });

    it('answers 409 LEAD_PERSONA_TAKEN when the unique index fires', async () => {
      manager.update.mockRejectedValueOnce(
        uniqueViolation('UQ_leads_linked_subprofile'),
      );
      personaHolder = { id: OTHER_LEAD_ID, name: 'Other lead' };

      const outcome = await codeOf(
        service.updateLead(LEAD_ID, ADMIN, {
          linkedSubprofileId: SECOND_PERSONA_ID,
        }),
      );

      expect(outcome).toMatchObject({
        code: 'LEAD_PERSONA_TAKEN',
        status: 409,
        body: { leadId: OTHER_LEAD_ID, leadName: 'Other lead' },
      });
      expect(manager.findOne).toHaveBeenLastCalledWith(Lead, {
        where: { linkedSubprofileId: SECOND_PERSONA_ID },
        select: { id: true, name: true },
      });
    });
  });

  describe('deleteLead', () => {
    it('writes the lead_deleted audit row with ids only, then deletes the lead', async () => {
      storedLead = buildLead({ linkedSubprofileId: PERSONA_ID });

      const answer = await service.deleteLead(LEAD_ID, ADMIN);

      expect(answer).toEqual({ ok: true });
      expect(dataSource.transaction).toHaveBeenCalledTimes(1);
      expect(manager.query.mock.calls[0]).toEqual([LOCK_LEADS_SQL]);
      expect(callOrderOf(manager.query)).toBeLessThan(
        callOrderOf(manager.findOne),
      );
      expect(manager.findOne).toHaveBeenCalledWith(Lead, {
        where: { id: LEAD_ID },
        select: { id: true, linkedSubprofileId: true },
        lock: { mode: 'pessimistic_write' },
      });
      expect(auditRepository.save).toHaveBeenCalledWith({
        reportId: null,
        actorId: ADMIN_ID,
        action: 'lead_deleted',
        targetUserId: null,
        targetName: null,
        reasonCode: null,
        duration: null,
        note: `lead:${LEAD_ID} persona:${PERSONA_ID}`,
      });
      expect(manager.delete).toHaveBeenCalledWith(Lead, { id: LEAD_ID });
      expect(callOrderOf(auditRepository.save)).toBeLessThan(
        callOrderOf(manager.delete),
      );

      expect(
        await codeOf(service.deleteLead('not-a-uuid', ADMIN)),
      ).toMatchObject({ code: 'LEAD_NOT_FOUND', status: 404 });

      storedLead = null;
      manager.delete.mockClear();

      expect(await codeOf(service.deleteLead(LEAD_ID, ADMIN))).toMatchObject({
        code: 'LEAD_NOT_FOUND',
        status: 404,
      });
      expect(manager.delete).not.toHaveBeenCalled();
    });
  });
});
