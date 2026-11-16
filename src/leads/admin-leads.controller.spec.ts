import { ExecutionContext, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { NotificationsModule } from '../notifications/notifications.module';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminLeadsController } from './admin-leads.controller';
import { LeadAssignee } from './entities/lead-assignee.entity';
import { LeadEntry } from './entities/lead-entry.entity';
import { Lead } from './entities/lead.entity';
import { LeadAssigneesService } from './lead-assignees.service';
import { LeadEntriesService } from './lead-entries.service';
import { LeadPersonaService } from './lead-persona.service';
import { LeadsModule } from './leads.module';
import { LeadsService } from './leads.service';

const CALLER_ID = 'f9100000-0000-4000-8000-000000000001';
const LEAD_ID = 'f9100000-0000-4000-8000-000000000011';
const ENTRY_ID = 'f9100000-0000-4000-8000-000000000021';
const TARGET_ID = 'f9100000-0000-4000-8000-000000000002';

const CALLER = {
  userId: CALLER_ID,
  email: 'staff@example.test',
  role: UserRole.Member,
} as CurrentUserData;

const USER = { userId: CALLER_ID, role: UserRole.Member } as CurrentUserData;

/** Every handler, in the order the class declares them. */
const HANDLER_NAMES = [
  'listLeads',
  'dueCount',
  'searchPersonas',
  'searchStaff',
  'createLead',
  'getLead',
  'updateLead',
  'deleteLead',
  'addNote',
  'editNote',
  'deleteNote',
  'revertStageChange',
  'assignStaff',
  'unassignStaff',
] as const;

type HandlerName = (typeof HANDLER_NAMES)[number];

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    AdminLeadsController.prototype as unknown as Record<
      string,
      HandlerFunction | undefined
    >
  )[handlerName];
  if (!handler) {
    throw new Error(`No handler named ${handlerName} on the controller`);
  }
  return handler;
};

const pathOf = (handlerName: HandlerName): string =>
  Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName)) as string;

const methodOf = (handlerName: HandlerName): RequestMethod =>
  Reflect.getMetadata(METHOD_METADATA, handlerOf(handlerName)) as RequestMethod;

describe('AdminLeadsController access', () => {
  const reflector = new Reflector();

  it('gates the class to Admin and the music_manager_producer grant', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminLeadsController)).toEqual([
      ActiveMemberGuard,
      RolesOrStaffGuard,
    ]);
    expect(reflector.get(ROLES_KEY, AdminLeadsController)).toEqual([
      UserRole.Admin,
    ]);
    expect(reflector.get(STAFF_ROLES_KEY, AdminLeadsController)).toEqual([
      'music_manager_producer',
    ]);
  });

  it.each(HANDLER_NAMES)(
    '%s adds no handler-level role or grant',
    (handlerName) => {
      expect(reflector.get(ROLES_KEY, handlerOf(handlerName))).toBeUndefined();
      expect(
        reflector.get(STAFF_ROLES_KEY, handlerOf(handlerName)),
      ).toBeUndefined();
      expect(
        Reflect.getMetadata(GUARDS_METADATA, handlerOf(handlerName)),
      ).toBeUndefined();
    },
  );

  it.each([
    [UserRole.Admin, false, true],
    [UserRole.Moderator, false, false],
    // A plain member holding the music_manager_producer grant.
    [UserRole.Member, true, true],
    [UserRole.Member, false, false],
  ])(
    'RolesOrStaffGuard lets role %s (grant held: %s) through: %s',
    async (role, hasGrant, isAllowed) => {
      const exists = jest.fn().mockResolvedValue(hasGrant);
      const guard = new RolesOrStaffGuard(new Reflector(), {
        exists,
      } as unknown as Repository<UserStaffRole>);
      const context = {
        getHandler: () => handlerOf('updateLead'),
        getClass: () => AdminLeadsController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: CALLER_ID, role } }),
        }),
      } as unknown as ExecutionContext;

      expect(await guard.canActivate(context)).toBe(isAllowed);
      if (role !== UserRole.Admin) {
        expect(exists).toHaveBeenCalledWith({
          where: [{ userId: CALLER_ID, role: 'music_manager_producer' }],
        });
      }
    },
  );

  it('carries no feature tag on the class or any handler', () => {
    expect(Reflect.getMetadata(FEATURE_KEY, AdminLeadsController)).toBe(
      undefined,
    );
    for (const handlerName of HANDLER_NAMES) {
      expect(Reflect.getMetadata(FEATURE_KEY, handlerOf(handlerName))).toBe(
        undefined,
      );
    }
  });
});

describe('AdminLeadsController routes', () => {
  it('serves admin/leads', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminLeadsController)).toBe(
      'admin/leads',
    );
  });

  it('maps each handler to its verb and path', () => {
    const routes = HANDLER_NAMES.map((handlerName) => [
      handlerName,
      methodOf(handlerName),
      pathOf(handlerName),
    ]);

    expect(routes).toEqual([
      ['listLeads', RequestMethod.GET, '/'],
      ['dueCount', RequestMethod.GET, 'due-count'],
      ['searchPersonas', RequestMethod.GET, 'personas/search'],
      ['searchStaff', RequestMethod.GET, 'staff'],
      ['createLead', RequestMethod.POST, '/'],
      ['getLead', RequestMethod.GET, ':id'],
      ['updateLead', RequestMethod.PATCH, ':id'],
      ['deleteLead', RequestMethod.DELETE, ':id'],
      ['addNote', RequestMethod.POST, ':id/entries'],
      ['editNote', RequestMethod.PATCH, ':id/entries/:entryId'],
      ['deleteNote', RequestMethod.DELETE, ':id/entries/:entryId'],
      ['revertStageChange', RequestMethod.POST, ':id/entries/:entryId/revert'],
      ['assignStaff', RequestMethod.POST, ':id/assignees'],
      ['unassignStaff', RequestMethod.DELETE, ':id/assignees/:userId'],
    ]);
  });

  it('answers 200 on a revert', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('revertStageChange')),
    ).toBe(HttpStatus.OK);
  });

  it('answers 200 on an assign', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('assignStaff')),
    ).toBe(HttpStatus.OK);
  });

  it('declares the literal routes before :id', () => {
    const declaredHandlers = Object.getOwnPropertyNames(
      AdminLeadsController.prototype,
    ).filter((propertyName) => propertyName !== 'constructor');

    expect(declaredHandlers).toEqual([...HANDLER_NAMES]);
    expect(declaredHandlers.indexOf('dueCount')).toBeLessThan(
      declaredHandlers.indexOf('getLead'),
    );
    expect(declaredHandlers.indexOf('searchPersonas')).toBeLessThan(
      declaredHandlers.indexOf('getLead'),
    );
    expect(declaredHandlers.indexOf('searchStaff')).toBeLessThan(
      declaredHandlers.indexOf('getLead'),
    );
  });

  it('binds no pipe to :id, :entryId or :userId', () => {
    for (const handlerName of [
      'getLead',
      'editNote',
      'revertStageChange',
      'unassignStaff',
    ] as const) {
      const routeArguments = Object.values(
        Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          AdminLeadsController,
          handlerName,
        ) as Record<string, { data?: unknown; pipes?: unknown[] }>,
      );
      const idArguments = routeArguments.filter(
        (routeArgument) =>
          routeArgument.data === 'id' ||
          routeArgument.data === 'entryId' ||
          routeArgument.data === 'userId',
      );

      expect(idArguments).toHaveLength(handlerName === 'getLead' ? 1 : 2);
      for (const routeArgument of routeArguments) {
        expect(routeArgument.pipes ?? []).toEqual([]);
      }
    }
  });

  it('registers the controller and the four services in LeadsModule', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      LeadsModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      'providers',
      LeadsModule,
    ) as unknown[];
    const exportedProviders = Reflect.getMetadata('exports', LeadsModule) as
      unknown[] | undefined;
    const importedModules = Reflect.getMetadata('imports', LeadsModule) as {
      providers?: { provide?: unknown }[];
    }[];
    const entityTokens = importedModules.flatMap((importedModule) =>
      (importedModule.providers ?? []).map((provider) => provider.provide),
    );

    expect(controllers).toEqual([AdminLeadsController]);
    expect(providers).toEqual(
      expect.arrayContaining([
        LeadsService,
        LeadEntriesService,
        LeadPersonaService,
        LeadAssigneesService,
      ]),
    );
    expect(providers).toHaveLength(4);
    expect(exportedProviders ?? []).toEqual([]);
    expect(entityTokens).toEqual(
      expect.arrayContaining([
        getRepositoryToken(Lead),
        getRepositoryToken(LeadEntry),
        getRepositoryToken(LeadAssignee),
        getRepositoryToken(UserStaffRole),
      ]),
    );
    expect(importedModules).toContain(NotificationsModule);
  });
});

describe('AdminLeadsController delegation', () => {
  const lead = { id: LEAD_ID, entries: [] };
  let leadsService: {
    listLeads: jest.Mock;
    dueCount: jest.Mock;
    createLead: jest.Mock;
    getLead: jest.Mock;
    updateLead: jest.Mock;
    deleteLead: jest.Mock;
  };
  let leadEntriesService: {
    addNote: jest.Mock;
    editNote: jest.Mock;
    deleteNote: jest.Mock;
    revertStageChange: jest.Mock;
  };
  let leadPersonaService: { searchPersonas: jest.Mock };
  let leadAssigneesService: {
    searchStaff: jest.Mock;
    assign: jest.Mock;
    unassign: jest.Mock;
  };
  let controller: AdminLeadsController;

  beforeEach(() => {
    leadsService = {
      listLeads: jest.fn(),
      dueCount: jest.fn(),
      createLead: jest.fn().mockResolvedValue(lead),
      getLead: jest.fn().mockResolvedValue(lead),
      updateLead: jest.fn().mockResolvedValue(lead),
      deleteLead: jest.fn().mockResolvedValue({ ok: true }),
    };
    leadEntriesService = {
      addNote: jest.fn().mockResolvedValue(lead),
      editNote: jest.fn().mockResolvedValue(lead),
      deleteNote: jest.fn().mockResolvedValue(lead),
      revertStageChange: jest.fn().mockResolvedValue(lead),
    };
    leadPersonaService = { searchPersonas: jest.fn() };
    leadAssigneesService = {
      searchStaff: jest.fn(),
      assign: jest.fn().mockResolvedValue(lead),
      unassign: jest.fn().mockResolvedValue(lead),
    };
    controller = new AdminLeadsController(
      leadsService as unknown as LeadsService,
      leadEntriesService as unknown as LeadEntriesService,
      leadPersonaService as unknown as LeadPersonaService,
      leadAssigneesService as unknown as LeadAssigneesService,
    );
  });

  it('passes the query and caller through on list', async () => {
    const page = {
      items: [],
      nextCursor: null,
      stageCounts: {},
      totalCount: 0,
      dueCount: 0,
    };
    leadsService.listLeads.mockResolvedValue(page);
    const query = { q: 'ana', stage: 'contacted', due: 'true' };

    const result = await controller.listLeads(query, USER);

    expect(leadsService.listLeads).toHaveBeenCalledWith(query, USER);
    expect(result).toBe(page);
  });

  it('passes the caller through on the due count', async () => {
    const dueCount = { count: 3 };
    leadsService.dueCount.mockResolvedValue(dueCount);

    await expect(controller.dueCount(USER)).resolves.toBe(dueCount);
    expect(leadsService.dueCount).toHaveBeenCalledTimes(1);
    expect(leadsService.dueCount).toHaveBeenCalledWith(USER);
  });

  it('passes the id, caller and body through on every lead route', async () => {
    const createBody = { name: 'Ana', type: 'dj' };
    const updateBody = { stage: 'in_talks' };

    const created = await controller.createLead(CALLER, createBody);
    const fetched = await controller.getLead(LEAD_ID, CALLER);
    const updated = await controller.updateLead(LEAD_ID, CALLER, updateBody);
    const deleted = await controller.deleteLead(LEAD_ID, CALLER);

    expect(leadsService.createLead).toHaveBeenCalledWith(CALLER, createBody);
    expect(leadsService.getLead).toHaveBeenCalledWith(LEAD_ID, CALLER);
    expect(leadsService.updateLead).toHaveBeenCalledWith(
      LEAD_ID,
      CALLER,
      updateBody,
    );
    expect(leadsService.deleteLead).toHaveBeenCalledWith(LEAD_ID, CALLER);
    expect(created).toBe(lead);
    expect(fetched).toBe(lead);
    expect(updated).toBe(lead);
    expect(deleted).toEqual({ ok: true });
  });

  it('passes the ids and caller through on every note route', async () => {
    const addBody = { body: 'hi' };
    const editBody = { body: 'hello' };

    const added = await controller.addNote(LEAD_ID, CALLER, addBody);
    const edited = await controller.editNote(
      LEAD_ID,
      ENTRY_ID,
      CALLER,
      editBody,
    );
    const deleted = await controller.deleteNote(LEAD_ID, ENTRY_ID, CALLER);

    // The service reads `body` off the request body itself.
    expect(leadEntriesService.addNote).toHaveBeenCalledWith(
      LEAD_ID,
      CALLER,
      addBody,
    );
    expect(leadEntriesService.editNote).toHaveBeenCalledWith(
      LEAD_ID,
      ENTRY_ID,
      CALLER,
      editBody,
    );
    expect(leadEntriesService.deleteNote).toHaveBeenCalledWith(
      LEAD_ID,
      ENTRY_ID,
      CALLER,
    );
    expect(added).toBe(lead);
    expect(edited).toBe(lead);
    expect(deleted).toBe(lead);
  });

  it('passes the ids and caller through on a stage change revert', async () => {
    const reverted = await controller.revertStageChange(
      LEAD_ID,
      ENTRY_ID,
      CALLER,
    );

    expect(leadEntriesService.revertStageChange).toHaveBeenCalledTimes(1);
    expect(leadEntriesService.revertStageChange).toHaveBeenCalledWith(
      LEAD_ID,
      ENTRY_ID,
      CALLER,
    );
    expect(reverted).toBe(lead);
  });

  it('passes q through on persona search', async () => {
    const searchResult = {
      items: [{ persona: { id: 'p' }, linkedLead: null }],
    };
    leadPersonaService.searchPersonas.mockResolvedValue(searchResult);

    const result = await controller.searchPersonas({ q: '@ana' });

    expect(leadPersonaService.searchPersonas).toHaveBeenCalledWith('@ana');
    expect(result).toBe(searchResult);
  });

  it('passes q and the caller through on staff search', async () => {
    const query = { q: 'ana' };
    const searchResult = { items: [{ id: TARGET_ID }] };
    leadAssigneesService.searchStaff.mockResolvedValue(searchResult);

    const result = await controller.searchStaff(query, USER);

    expect(leadAssigneesService.searchStaff).toHaveBeenCalledWith(
      query.q,
      USER,
    );
    expect(result).toBe(searchResult);
  });

  it('passes the id, caller and body through on assign', async () => {
    const body = { userId: TARGET_ID };

    const assigned = await controller.assignStaff(LEAD_ID, USER, body);

    expect(leadAssigneesService.assign).toHaveBeenCalledTimes(1);
    expect(leadAssigneesService.assign).toHaveBeenCalledWith(
      LEAD_ID,
      USER,
      body,
    );
    expect(assigned).toBe(lead);
  });

  it('passes both ids and the caller through on unassign', async () => {
    const unassigned = await controller.unassignStaff(LEAD_ID, TARGET_ID, USER);

    expect(leadAssigneesService.unassign).toHaveBeenCalledTimes(1);
    expect(leadAssigneesService.unassign).toHaveBeenCalledWith(
      LEAD_ID,
      TARGET_ID,
      USER,
    );
    expect(unassigned).toBe(lead);
  });
});
