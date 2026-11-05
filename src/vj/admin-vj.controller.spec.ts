import { ExecutionContext, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
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
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminVjController } from './admin-vj.controller';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import { VjLibraryService } from './vj-library.service';
import { VjStageService } from './vj-stage.service';
import { VjGateway } from './vj.gateway';
import { VjModule } from './vj.module';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PACK_ID = '22222222-2222-4222-8222-222222222222';
const CLIP_ID = '33333333-3333-4333-8333-333333333333';

/** The handlers in the contract's declaration order. */
const HANDLER_NAMES = [
  'listPacks',
  'createPack',
  'reorderPacks',
  'getPackClips',
  'getPackMedia',
  'addPackClip',
  'reorderPackClips',
  'removePackClip',
  'renamePack',
  'deletePack',
  'listClips',
  'createClip',
  'updateClip',
  'deleteClip',
] as const;

type HandlerName = (typeof HANDLER_NAMES)[number];

const GET_HANDLER_NAMES: HandlerName[] = [
  'listPacks',
  'getPackClips',
  'getPackMedia',
  'listClips',
];

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    AdminVjController.prototype as unknown as Record<
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

interface RouteArgument {
  index: number;
  data?: unknown;
  pipes?: unknown[];
}

const routeArgumentsOf = (handlerName: HandlerName): RouteArgument[] =>
  Object.values(
    (Reflect.getMetadata(ROUTE_ARGS_METADATA, AdminVjController, handlerName) ??
      {}) as Record<string, RouteArgument>,
  );

describe('AdminVjController access', () => {
  const reflector = new Reflector();

  it('gates the class to Admin with the grant axis off', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, AdminVjController)).toEqual([
      ActiveMemberGuard,
      RolesOrStaffGuard,
    ]);
    expect(reflector.get(ROLES_KEY, AdminVjController)).toEqual([
      UserRole.Admin,
    ]);
    expect(reflector.get(STAFF_ROLES_KEY, AdminVjController)).toEqual([]);
    expect(reflector.get(FEATURE_KEY, AdminVjController)).toBeUndefined();
  });

  it.each([
    [UserRole.Admin, false, true],
    [UserRole.Moderator, false, false],
    // A plain member holding a staff grant.
    [UserRole.Member, true, false],
  ])(
    'RolesOrStaffGuard lets role %s (grant held: %s) through: %s',
    async (role, hasGrant, isAllowed) => {
      const guard = new RolesOrStaffGuard(new Reflector(), {
        exists: jest.fn().mockResolvedValue(hasGrant),
      } as unknown as Repository<UserStaffRole>);
      const context = {
        getHandler: () => handlerOf('createClip'),
        getClass: () => AdminVjController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: ADMIN_ID, role } }),
        }),
      } as unknown as ExecutionContext;

      expect(await guard.canActivate(context)).toBe(isAllowed);
    },
  );

  it.each(HANDLER_NAMES)(
    '%s adds no handler-level role, grant or feature tag',
    (handlerName) => {
      expect(reflector.get(ROLES_KEY, handlerOf(handlerName))).toBeUndefined();
      expect(
        reflector.get(STAFF_ROLES_KEY, handlerOf(handlerName)),
      ).toBeUndefined();
      expect(
        reflector.get(FEATURE_KEY, handlerOf(handlerName)),
      ).toBeUndefined();
    },
  );
});

describe('AdminVjController routes', () => {
  it('serves admin/vj and maps each handler to its verb and path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminVjController)).toBe(
      'admin/vj',
    );
    const expectedRoutes: [HandlerName, RequestMethod, string][] = [
      ['listPacks', RequestMethod.GET, 'packs'],
      ['createPack', RequestMethod.POST, 'packs'],
      ['reorderPacks', RequestMethod.PATCH, 'packs/reorder'],
      ['getPackClips', RequestMethod.GET, 'packs/:id/clips'],
      ['getPackMedia', RequestMethod.GET, 'packs/:id/media'],
      ['addPackClip', RequestMethod.POST, 'packs/:id/clips'],
      ['reorderPackClips', RequestMethod.PATCH, 'packs/:id/clips/reorder'],
      ['removePackClip', RequestMethod.DELETE, 'packs/:id/clips/:clipId'],
      ['renamePack', RequestMethod.PATCH, 'packs/:id'],
      ['deletePack', RequestMethod.DELETE, 'packs/:id'],
      ['listClips', RequestMethod.GET, 'clips'],
      ['createClip', RequestMethod.POST, 'clips'],
      ['updateClip', RequestMethod.PATCH, 'clips/:id'],
      ['deleteClip', RequestMethod.DELETE, 'clips/:id'],
    ];
    expect(expectedRoutes.map(([handlerName]) => handlerName)).toEqual([
      ...HANDLER_NAMES,
    ]);
    for (const [handlerName, method, path] of expectedRoutes) {
      expect(methodOf(handlerName)).toBe(method);
      expect(pathOf(handlerName)).toBe(path);
    }
  });

  it('declares the literal routes before the parameter routes', () => {
    const declared = Object.getOwnPropertyNames(
      AdminVjController.prototype,
    ).filter((propertyName) => propertyName !== 'constructor');
    expect(declared).toEqual([...HANDLER_NAMES]);
  });

  it('binds no pipe to :id or :clipId', () => {
    for (const handlerName of HANDLER_NAMES) {
      const idArguments = routeArgumentsOf(handlerName).filter(
        (routeArgument) =>
          routeArgument.data === 'id' || routeArgument.data === 'clipId',
      );
      for (const routeArgument of idArguments) {
        expect(routeArgument.pipes ?? []).toEqual([]);
      }
    }
    expect(
      routeArgumentsOf('removePackClip').map(
        (routeArgument) => routeArgument.data,
      ),
    ).toEqual(expect.arrayContaining(['id', 'clipId']));
  });

  it('answers no-store on every GET', () => {
    for (const handlerName of GET_HANDLER_NAMES) {
      expect(methodOf(handlerName)).toBe(RequestMethod.GET);
      expect(
        Reflect.getMetadata(HEADERS_METADATA, handlerOf(handlerName)),
      ).toEqual(
        expect.arrayContaining([{ name: 'Cache-Control', value: 'no-store' }]),
      );
    }
  });

  it('answers no-store only on the GETs', () => {
    const writeHandlerNames = HANDLER_NAMES.filter(
      (handlerName) => !GET_HANDLER_NAMES.includes(handlerName),
    );
    for (const handlerName of writeHandlerNames) {
      expect(
        Reflect.getMetadata(HEADERS_METADATA, handlerOf(handlerName)),
      ).toBeUndefined();
    }
  });
});

describe('AdminVjController delegation', () => {
  const caller = { userId: ADMIN_ID } as CurrentUserData;
  const answer = { marker: 'service answer' };
  let library: Record<
    | 'listPacks'
    | 'createPack'
    | 'reorderPacks'
    | 'getPackClips'
    | 'getPackMedia'
    | 'addPackClip'
    | 'reorderPackClips'
    | 'removePackClip'
    | 'renamePack'
    | 'deletePack'
    | 'listClips'
    | 'createClip'
    | 'updateClip'
    | 'deleteClip',
    jest.Mock
  >;
  let controller: AdminVjController;

  beforeEach(() => {
    library = {
      listPacks: jest.fn().mockResolvedValue(answer),
      createPack: jest.fn().mockResolvedValue(answer),
      reorderPacks: jest.fn().mockResolvedValue(answer),
      getPackClips: jest.fn().mockResolvedValue(answer),
      getPackMedia: jest.fn().mockResolvedValue(answer),
      addPackClip: jest.fn().mockResolvedValue(answer),
      reorderPackClips: jest.fn().mockResolvedValue(answer),
      removePackClip: jest.fn().mockResolvedValue(answer),
      renamePack: jest.fn().mockResolvedValue(answer),
      deletePack: jest.fn().mockResolvedValue(answer),
      listClips: jest.fn().mockResolvedValue(answer),
      createClip: jest.fn().mockResolvedValue(answer),
      updateClip: jest.fn().mockResolvedValue(answer),
      deleteClip: jest.fn().mockResolvedValue(answer),
    };
    controller = new AdminVjController(library as unknown as VjLibraryService);
  });

  it('passes the caller through on createPack and createClip and the ids through elsewhere', async () => {
    const packBody = { name: 'Peak hour' };
    const clipBody = { title: 'Loop', storageKey: 'vj-clips/a/b.mp4' };
    const packIdsBody = { packIds: [PACK_ID] };
    const clipIdsBody = { clipIds: [CLIP_ID] };
    const clipAddBody = { clipId: CLIP_ID };
    const renameBody = { name: 'Late set' };
    const updateBody = { title: 'Loop 2', fitMode: 'fit' };
    const mediaQuery = { clipIds: CLIP_ID };

    await expect(controller.listPacks()).resolves.toBe(answer);
    await expect(controller.createPack(caller, packBody)).resolves.toBe(answer);
    await expect(controller.reorderPacks(packIdsBody)).resolves.toBe(answer);
    await expect(controller.getPackClips(PACK_ID)).resolves.toBe(answer);
    await expect(controller.getPackMedia(PACK_ID, mediaQuery)).resolves.toBe(
      answer,
    );
    await expect(controller.addPackClip(PACK_ID, clipAddBody)).resolves.toBe(
      answer,
    );
    await expect(
      controller.reorderPackClips(PACK_ID, clipIdsBody),
    ).resolves.toBe(answer);
    await expect(controller.removePackClip(PACK_ID, CLIP_ID)).resolves.toBe(
      answer,
    );
    await expect(controller.renamePack(PACK_ID, renameBody)).resolves.toBe(
      answer,
    );
    await expect(controller.deletePack(PACK_ID)).resolves.toBe(answer);
    await expect(controller.listClips()).resolves.toBe(answer);
    await expect(controller.createClip(caller, clipBody)).resolves.toBe(answer);
    await expect(controller.updateClip(CLIP_ID, updateBody)).resolves.toBe(
      answer,
    );
    await expect(controller.deleteClip(CLIP_ID)).resolves.toBe(answer);

    expect(library.createPack).toHaveBeenCalledWith(caller, packBody);
    expect(library.reorderPacks).toHaveBeenCalledWith(packIdsBody);
    expect(library.getPackClips).toHaveBeenCalledWith(PACK_ID);
    expect(library.getPackMedia).toHaveBeenCalledWith(PACK_ID, mediaQuery);
    expect(library.addPackClip).toHaveBeenCalledWith(PACK_ID, clipAddBody);
    expect(library.reorderPackClips).toHaveBeenCalledWith(PACK_ID, clipIdsBody);
    expect(library.removePackClip).toHaveBeenCalledWith(PACK_ID, CLIP_ID);
    expect(library.renamePack).toHaveBeenCalledWith(PACK_ID, renameBody);
    expect(library.deletePack).toHaveBeenCalledWith(PACK_ID);
    expect(library.createClip).toHaveBeenCalledWith(caller, clipBody);
    expect(library.updateClip).toHaveBeenCalledWith(CLIP_ID, updateBody);
    expect(library.deleteClip).toHaveBeenCalledWith(CLIP_ID);
  });
});

describe('VjModule', () => {
  it('registers the controller, the two services, the gateway and the handshake entities in VjModule', () => {
    const controllers = Reflect.getMetadata(
      'controllers',
      VjModule,
    ) as unknown[];
    const providers = Reflect.getMetadata('providers', VjModule) as unknown[];
    const importedModules = Reflect.getMetadata('imports', VjModule) as {
      providers?: { provide?: unknown }[];
    }[];
    const entityTokens = importedModules.flatMap((importedModule) =>
      (importedModule.providers ?? []).map((provider) => provider.provide),
    );

    expect(controllers).toEqual([AdminVjController]);
    expect(providers).toEqual([VjLibraryService, VjStageService, VjGateway]);
    for (const entity of [
      VjClip,
      VjPack,
      VjPackClip,
      UserStaffRole,
      RefreshToken,
    ]) {
      expect(entityTokens).toContain(getRepositoryToken(entity));
    }
  });
});
