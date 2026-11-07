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
import { Event } from '../events/entities/event.entity';
import { VJ_KEY_HANDLERS } from '../storage/shared-upload-handlers';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminVjController } from './admin-vj.controller';
import { VjClip } from './entities/vj-clip.entity';
import { VjPackClip } from './entities/vj-pack-clip.entity';
import { VjPack } from './entities/vj-pack.entity';
import { VjScene } from './entities/vj-scene.entity';
import { VjSetlistItem } from './entities/vj-setlist-item.entity';
import { VjSetlist } from './entities/vj-setlist.entity';
import { VjEventLinkService } from './vj-event-link.service';
import { VjLibraryService } from './vj-library.service';
import { VjSceneService } from './vj-scene.service';
import { VjSetlistService } from './vj-setlist.service';
import { VjStageReadsService } from './vj-stage-reads.service';
import { VjStageService } from './vj-stage.service';
import { VjGateway } from './vj.gateway';
import { VjModule } from './vj.module';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const PACK_ID = '22222222-2222-4222-8222-222222222222';
const CLIP_ID = '33333333-3333-4333-8333-333333333333';
const EVENT_ID = '44444444-4444-4444-8444-444444444444';
const SCENE_ID = '55555555-5555-4555-8555-555555555555';
const SETLIST_ID = '66666666-6666-4666-8666-666666666666';

/** The 30 routes in the contract's declaration order (contract 6): handler,
 *  verb, path. */
const EXPECTED_ROUTES = [
  ['listPacks', RequestMethod.GET, 'packs'],
  ['createPack', RequestMethod.POST, 'packs'],
  ['reorderPacks', RequestMethod.PATCH, 'packs/reorder'],
  ['getPackClips', RequestMethod.GET, 'packs/:id/clips'],
  ['getPackMedia', RequestMethod.GET, 'packs/:id/media'],
  ['getPackEvent', RequestMethod.GET, 'packs/:id/event'],
  ['addPackClip', RequestMethod.POST, 'packs/:id/clips'],
  ['reorderPackClips', RequestMethod.PATCH, 'packs/:id/clips/reorder'],
  ['setPackEvent', RequestMethod.PATCH, 'packs/:id/event'],
  ['removePackClip', RequestMethod.DELETE, 'packs/:id/clips/:clipId'],
  ['renamePack', RequestMethod.PATCH, 'packs/:id'],
  ['deletePack', RequestMethod.DELETE, 'packs/:id'],
  ['listClips', RequestMethod.GET, 'clips'],
  ['getClipsMedia', RequestMethod.GET, 'clips/media'],
  ['createClip', RequestMethod.POST, 'clips'],
  ['setClipPreview', RequestMethod.PUT, 'clips/:id/preview'],
  ['updateClip', RequestMethod.PATCH, 'clips/:id'],
  ['deleteClip', RequestMethod.DELETE, 'clips/:id'],
  ['listUpcomingEvents', RequestMethod.GET, 'events/upcoming'],
  ['listScenes', RequestMethod.GET, 'scenes'],
  ['createScene', RequestMethod.POST, 'scenes'],
  ['reorderScenes', RequestMethod.PATCH, 'scenes/reorder'],
  ['updateScene', RequestMethod.PATCH, 'scenes/:id'],
  ['deleteScene', RequestMethod.DELETE, 'scenes/:id'],
  ['listSetlists', RequestMethod.GET, 'setlists'],
  ['createSetlist', RequestMethod.POST, 'setlists'],
  ['reorderSetlists', RequestMethod.PATCH, 'setlists/reorder'],
  ['setSetlistItems', RequestMethod.PUT, 'setlists/:id/items'],
  ['renameSetlist', RequestMethod.PATCH, 'setlists/:id'],
  ['deleteSetlist', RequestMethod.DELETE, 'setlists/:id'],
] as const;

type HandlerName = (typeof EXPECTED_ROUTES)[number][0];

const HANDLER_NAMES: HandlerName[] = EXPECTED_ROUTES.map(
  ([handlerName]) => handlerName,
);

const GET_HANDLER_NAMES: HandlerName[] = [
  'listPacks',
  'getPackClips',
  'getPackMedia',
  'getPackEvent',
  'listClips',
  'getClipsMedia',
  'listUpcomingEvents',
  'listScenes',
  'listSetlists',
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

const declaredHandlerNames = (): string[] =>
  Object.getOwnPropertyNames(AdminVjController.prototype).filter(
    (propertyName) => propertyName !== 'constructor',
  );

describe('AdminVjController access', () => {
  const reflector = new Reflector();

  it('declares the 30 routes in the contract order under the class gate', () => {
    expect(EXPECTED_ROUTES).toHaveLength(30);
    expect(declaredHandlerNames()).toEqual(HANDLER_NAMES);
    expect(Reflect.getMetadata(PATH_METADATA, AdminVjController)).toBe(
      'admin/vj',
    );
    for (const [handlerName, method, path] of EXPECTED_ROUTES) {
      expect(methodOf(handlerName)).toBe(method);
      expect(pathOf(handlerName)).toBe(path);
    }
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
        getHandler: () => handlerOf('createScene'),
        getClass: () => AdminVjController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: ADMIN_ID, role } }),
        }),
      } as unknown as ExecutionContext;

      expect(await guard.canActivate(context)).toBe(isAllowed);
    },
  );

  it.each(HANDLER_NAMES)(
    '%s adds no handler-level guard, role, grant or feature tag',
    (handlerName) => {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, handlerOf(handlerName)),
      ).toBeUndefined();
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
  it.each([
    ['reorderPacks', 'renamePack'],
    ['reorderPacks', 'deletePack'],
    ['getClipsMedia', 'setClipPreview'],
    ['getClipsMedia', 'updateClip'],
    ['getClipsMedia', 'deleteClip'],
    ['reorderScenes', 'updateScene'],
    ['reorderScenes', 'deleteScene'],
    ['reorderSetlists', 'setSetlistItems'],
    ['reorderSetlists', 'renameSetlist'],
    ['reorderSetlists', 'deleteSetlist'],
  ] as [HandlerName, HandlerName][])(
    'declares the literal route %s before the parameter route %s',
    (literalHandlerName, parameterHandlerName) => {
      const declared = declaredHandlerNames();
      expect(pathOf(literalHandlerName)).not.toContain(':');
      expect(pathOf(parameterHandlerName)).toContain(':id');
      expect(declared.indexOf(literalHandlerName)).toBeLessThan(
        declared.indexOf(parameterHandlerName),
      );
    },
  );

  it('binds no pipe to any id', () => {
    for (const handlerName of HANDLER_NAMES) {
      for (const routeArgument of routeArgumentsOf(handlerName)) {
        expect(routeArgument.pipes ?? []).toEqual([]);
      }
    }
    expect(
      routeArgumentsOf('removePackClip').map(
        (routeArgument) => routeArgument.data,
      ),
    ).toEqual(expect.arrayContaining(['id', 'clipId']));
    for (const handlerName of [
      'getPackEvent',
      'setPackEvent',
      'setClipPreview',
      'updateScene',
      'deleteScene',
      'setSetlistItems',
      'renameSetlist',
      'deleteSetlist',
    ] as HandlerName[]) {
      expect(
        routeArgumentsOf(handlerName).map(
          (routeArgument) => routeArgument.data,
        ),
      ).toContain('id');
    }
  });

  it('answers no-store on every GET', () => {
    expect(GET_HANDLER_NAMES).toHaveLength(9);
    expect(
      HANDLER_NAMES.filter(
        (handlerName) => methodOf(handlerName) === RequestMethod.GET,
      ),
    ).toEqual(GET_HANDLER_NAMES);
    for (const handlerName of GET_HANDLER_NAMES) {
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

  it('names the preview handler setClipPreview for the key interceptor', () => {
    expect(pathOf('setClipPreview')).toBe('clips/:id/preview');
    expect(VJ_KEY_HANDLERS.has('AdminVjController.setClipPreview')).toBe(true);
    expect(VJ_KEY_HANDLERS.has('AdminVjController.createClip')).toBe(true);
  });
});

type MockedService<MethodName extends string> = Record<MethodName, jest.Mock>;

const mockedService = <MethodName extends string>(
  methodNames: readonly MethodName[],
  answer: unknown,
): MockedService<MethodName> =>
  Object.fromEntries(
    methodNames.map((methodName) => [
      methodName,
      jest.fn().mockResolvedValue(answer),
    ]),
  ) as MockedService<MethodName>;

const LIBRARY_METHOD_NAMES = [
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
  'getClipsMedia',
  'createClip',
  'setClipPreview',
  'updateClip',
  'deleteClip',
] as const;

const EVENT_LINK_METHOD_NAMES = [
  'getPackEvent',
  'setPackEvent',
  'listUpcomingEvents',
] as const;

const SCENE_METHOD_NAMES = [
  'listScenes',
  'createScene',
  'reorderScenes',
  'updateScene',
  'deleteScene',
] as const;

const SETLIST_METHOD_NAMES = [
  'listSetlists',
  'createSetlist',
  'reorderSetlists',
  'setSetlistItems',
  'renameSetlist',
  'deleteSetlist',
] as const;

describe('AdminVjController delegation', () => {
  const caller = { userId: ADMIN_ID } as CurrentUserData;
  const answer = { marker: 'service answer' };
  let library: MockedService<(typeof LIBRARY_METHOD_NAMES)[number]>;
  let eventLinks: MockedService<(typeof EVENT_LINK_METHOD_NAMES)[number]>;
  let scenes: MockedService<(typeof SCENE_METHOD_NAMES)[number]>;
  let setlists: MockedService<(typeof SETLIST_METHOD_NAMES)[number]>;
  let controller: AdminVjController;

  beforeEach(() => {
    library = mockedService(LIBRARY_METHOD_NAMES, answer);
    eventLinks = mockedService(EVENT_LINK_METHOD_NAMES, answer);
    scenes = mockedService(SCENE_METHOD_NAMES, answer);
    setlists = mockedService(SETLIST_METHOD_NAMES, answer);
    controller = new AdminVjController(
      library as unknown as VjLibraryService,
      eventLinks as unknown as VjEventLinkService,
      scenes as unknown as VjSceneService,
      setlists as unknown as VjSetlistService,
    );
  });

  it('passes the caller through on the creates and the ids through elsewhere', async () => {
    const packBody = { name: 'Peak hour' };
    const clipBody = { title: 'Loop', storageKey: 'vj-clips/a/b.mp4' };
    const sceneBody = { name: 'Opener', packId: PACK_ID, look: {} };
    const setlistBody = { name: 'Late set', sceneIds: [SCENE_ID] };

    await expect(controller.createPack(caller, packBody)).resolves.toBe(answer);
    await expect(controller.createClip(caller, clipBody)).resolves.toBe(answer);
    await expect(controller.createScene(caller, sceneBody)).resolves.toBe(
      answer,
    );
    await expect(controller.createSetlist(caller, setlistBody)).resolves.toBe(
      answer,
    );

    expect(library.createPack).toHaveBeenCalledWith(caller, packBody);
    expect(library.createClip).toHaveBeenCalledWith(caller, clipBody);
    expect(scenes.createScene).toHaveBeenCalledWith(caller, sceneBody);
    expect(setlists.createSetlist).toHaveBeenCalledWith(caller, setlistBody);
  });

  it('delegates the pack and clip routes to the library service', async () => {
    const packIdsBody = { packIds: [PACK_ID] };
    const clipIdsBody = { clipIds: [CLIP_ID] };
    const clipAddBody = { clipId: CLIP_ID };
    const renameBody = { name: 'Late set' };
    const updateBody = {
      title: 'Loop 2',
      fitMode: 'fit',
      isFavorite: true,
      defaultSpeed: 1.5,
      loopInMs: 0,
      loopOutMs: 2000,
      loopMode: 'pingPong',
    };
    const previewBody = { previewStorageKey: 'vj-previews/a.webp' };
    const mediaQuery = { clipIds: CLIP_ID };

    await expect(controller.listPacks()).resolves.toBe(answer);
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
    await expect(controller.getClipsMedia(mediaQuery)).resolves.toBe(answer);
    await expect(controller.setClipPreview(CLIP_ID, previewBody)).resolves.toBe(
      answer,
    );
    await expect(controller.updateClip(CLIP_ID, updateBody)).resolves.toBe(
      answer,
    );
    await expect(controller.deleteClip(CLIP_ID)).resolves.toBe(answer);

    expect(library.listPacks).toHaveBeenCalledWith();
    expect(library.reorderPacks).toHaveBeenCalledWith(packIdsBody);
    expect(library.getPackClips).toHaveBeenCalledWith(PACK_ID);
    expect(library.getPackMedia).toHaveBeenCalledWith(PACK_ID, mediaQuery);
    expect(library.addPackClip).toHaveBeenCalledWith(PACK_ID, clipAddBody);
    expect(library.reorderPackClips).toHaveBeenCalledWith(PACK_ID, clipIdsBody);
    expect(library.removePackClip).toHaveBeenCalledWith(PACK_ID, CLIP_ID);
    expect(library.renamePack).toHaveBeenCalledWith(PACK_ID, renameBody);
    expect(library.deletePack).toHaveBeenCalledWith(PACK_ID);
    expect(library.listClips).toHaveBeenCalledWith();
    expect(library.getClipsMedia).toHaveBeenCalledWith(mediaQuery);
    expect(library.setClipPreview).toHaveBeenCalledWith(CLIP_ID, previewBody);
    expect(library.updateClip).toHaveBeenCalledWith(CLIP_ID, updateBody);
    expect(library.deleteClip).toHaveBeenCalledWith(CLIP_ID);
  });

  it('delegates the event routes to the event link service', async () => {
    const linkBody = { eventId: EVENT_ID };

    await expect(controller.getPackEvent(PACK_ID)).resolves.toBe(answer);
    await expect(controller.setPackEvent(PACK_ID, linkBody)).resolves.toBe(
      answer,
    );
    await expect(controller.listUpcomingEvents()).resolves.toBe(answer);

    expect(eventLinks.getPackEvent).toHaveBeenCalledWith(PACK_ID);
    expect(eventLinks.setPackEvent).toHaveBeenCalledWith(PACK_ID, linkBody);
    expect(eventLinks.listUpcomingEvents).toHaveBeenCalledWith();
    expect(library.getPackClips).not.toHaveBeenCalled();
  });

  it('delegates the scene routes to the scene service', async () => {
    const reorderBody = { sceneIds: [SCENE_ID] };
    const updateBody = { name: 'Closer' };

    await expect(controller.listScenes()).resolves.toBe(answer);
    await expect(controller.reorderScenes(reorderBody)).resolves.toBe(answer);
    await expect(controller.updateScene(SCENE_ID, updateBody)).resolves.toBe(
      answer,
    );
    await expect(controller.deleteScene(SCENE_ID)).resolves.toBe(answer);

    expect(scenes.listScenes).toHaveBeenCalledWith();
    expect(scenes.reorderScenes).toHaveBeenCalledWith(reorderBody);
    expect(scenes.updateScene).toHaveBeenCalledWith(SCENE_ID, updateBody);
    expect(scenes.deleteScene).toHaveBeenCalledWith(SCENE_ID);
  });

  it('delegates the set list routes to the set list service', async () => {
    const reorderBody = { setlistIds: [SETLIST_ID] };
    const itemsBody = { sceneIds: [SCENE_ID, SCENE_ID] };
    const renameBody = { name: 'Warm up' };

    await expect(controller.listSetlists()).resolves.toBe(answer);
    await expect(controller.reorderSetlists(reorderBody)).resolves.toBe(answer);
    await expect(
      controller.setSetlistItems(SETLIST_ID, itemsBody),
    ).resolves.toBe(answer);
    await expect(
      controller.renameSetlist(SETLIST_ID, renameBody),
    ).resolves.toBe(answer);
    await expect(controller.deleteSetlist(SETLIST_ID)).resolves.toBe(answer);

    expect(setlists.listSetlists).toHaveBeenCalledWith();
    expect(setlists.reorderSetlists).toHaveBeenCalledWith(reorderBody);
    expect(setlists.setSetlistItems).toHaveBeenCalledWith(
      SETLIST_ID,
      itemsBody,
    );
    expect(setlists.renameSetlist).toHaveBeenCalledWith(SETLIST_ID, renameBody);
    expect(setlists.deleteSetlist).toHaveBeenCalledWith(SETLIST_ID);
  });
});

describe('VjModule', () => {
  it('registers the v2 providers and entities in VjModule', () => {
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
    expect(providers).toEqual([
      VjLibraryService,
      VjStageService,
      VjStageReadsService,
      VjEventLinkService,
      VjSceneService,
      VjSetlistService,
      VjGateway,
    ]);
    for (const entity of [
      VjClip,
      VjPack,
      VjPackClip,
      VjScene,
      VjSetlist,
      VjSetlistItem,
      Event,
      UserStaffRole,
      RefreshToken,
    ]) {
      expect(entityTokens).toContain(getRepositoryToken(entity));
    }
  });
});
