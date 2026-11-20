import { ExecutionContext, HttpStatus, RequestMethod } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { STAFF_ROLES_KEY } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { UserRole } from '../users/entities/user.entity';
import { AdminCulturalProductionController } from './admin-cultural-production.controller';
import { CulturalGuidesService } from './cultural-guides.service';
import { CulturalIdeasService } from './cultural-ideas.service';
import { CulturalTasksService } from './cultural-tasks.service';

const CALLER_ID = 'c7100000-0000-4000-8000-000000000001';
const TARGET_ID = 'c7100000-0000-4000-8000-000000000002';
const IDEA_ID = 'c7100000-0000-4000-8000-000000000011';
const COMMENT_ID = 'c7100000-0000-4000-8000-000000000021';
const TASK_ID = 'c7100000-0000-4000-8000-000000000031';
const GUIDE_ID = 'c7100000-0000-4000-8000-000000000041';

const CALLER = {
  userId: CALLER_ID,
  email: 'staff@example.test',
  role: UserRole.Member,
} as CurrentUserData;

/** Every handler with its verb and path, in the order the class declares them (contract 7.1). */
const ROUTE_TABLE = [
  ['searchStaff', RequestMethod.GET, 'staff'],
  ['dueCount', RequestMethod.GET, 'tasks/due-count'],
  ['listIdeas', RequestMethod.GET, 'ideas'],
  ['createIdea', RequestMethod.POST, 'ideas'],
  ['getIdea', RequestMethod.GET, 'ideas/:id'],
  ['updateIdea', RequestMethod.PATCH, 'ideas/:id'],
  ['deleteIdea', RequestMethod.DELETE, 'ideas/:id'],
  ['backIdea', RequestMethod.PUT, 'ideas/:id/backing'],
  ['unbackIdea', RequestMethod.DELETE, 'ideas/:id/backing'],
  ['addComment', RequestMethod.POST, 'ideas/:id/comments'],
  ['deleteComment', RequestMethod.DELETE, 'ideas/:id/comments/:commentId'],
  ['listTasks', RequestMethod.GET, 'tasks'],
  ['createTask', RequestMethod.POST, 'tasks'],
  ['getTask', RequestMethod.GET, 'tasks/:id'],
  ['updateTask', RequestMethod.PATCH, 'tasks/:id'],
  ['deleteTask', RequestMethod.DELETE, 'tasks/:id'],
  ['assignTask', RequestMethod.POST, 'tasks/:id/assignees'],
  ['unassignTask', RequestMethod.DELETE, 'tasks/:id/assignees/:userId'],
  ['listGuides', RequestMethod.GET, 'guides'],
  ['createGuide', RequestMethod.POST, 'guides'],
  ['getGuide', RequestMethod.GET, 'guides/:id'],
  ['replaceGuide', RequestMethod.PUT, 'guides/:id'],
  ['deleteGuide', RequestMethod.DELETE, 'guides/:id'],
  ['createTaskBatch', RequestMethod.POST, 'guides/:id/task-batches'],
] as const;

const HANDLER_NAMES = ROUTE_TABLE.map(([handlerName]) => handlerName);

type HandlerFunction = (...args: unknown[]) => unknown;

const handlerOf = (handlerName: string): HandlerFunction => {
  const handler = (
    AdminCulturalProductionController.prototype as unknown as Record<
      string,
      HandlerFunction | undefined
    >
  )[handlerName];
  if (!handler) {
    throw new Error(`No handler named ${handlerName} on the controller`);
  }
  return handler;
};

const declaredHandlerNames = (): string[] =>
  Object.getOwnPropertyNames(
    AdminCulturalProductionController.prototype,
  ).filter((propertyName) => propertyName !== 'constructor');

describe('AdminCulturalProductionController access', () => {
  it('admits moderators, admins and both grants through the class metadata', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminCulturalProductionController),
    ).toEqual([ActiveMemberGuard, RolesOrStaffGuard]);
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminCulturalProductionController),
    ).toEqual([UserRole.Moderator, UserRole.Admin]);
    expect(
      Reflect.getMetadata(STAFF_ROLES_KEY, AdminCulturalProductionController),
    ).toEqual(['cultural_producer', 'music_manager_producer']);
  });

  it('carries no handler-level role or grant override', () => {
    for (const handlerName of HANDLER_NAMES) {
      const handler = handlerOf(handlerName);
      expect(Reflect.getMetadata(ROLES_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(STAFF_ROLES_KEY, handler)).toBeUndefined();
      expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toBeUndefined();
    }
  });

  it.each([
    [UserRole.Admin, false, true],
    [UserRole.Moderator, false, true],
    // A plain member holding one of the two grants.
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
        getHandler: () => handlerOf('updateTask'),
        getClass: () => AdminCulturalProductionController,
        switchToHttp: () => ({
          getRequest: () => ({ user: { userId: CALLER_ID, role } }),
        }),
      } as unknown as ExecutionContext;

      expect(await guard.canActivate(context)).toBe(isAllowed);
      if (role === UserRole.Member) {
        expect(exists).toHaveBeenCalledWith({
          where: [
            { userId: CALLER_ID, role: 'cultural_producer' },
            { userId: CALLER_ID, role: 'music_manager_producer' },
          ],
        });
      }
    },
  );

  it('carries no feature tag on the class or any handler', () => {
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminCulturalProductionController),
    ).toBeUndefined();
    for (const handlerName of HANDLER_NAMES) {
      expect(
        Reflect.getMetadata(FEATURE_KEY, handlerOf(handlerName)),
      ).toBeUndefined();
    }
  });
});

describe('AdminCulturalProductionController routes', () => {
  it('serves admin/cultural-production', () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminCulturalProductionController),
    ).toBe('admin/cultural-production');
  });

  it('maps the 24 handlers to the contract verbs and paths', () => {
    const routes = HANDLER_NAMES.map((handlerName) => [
      handlerName,
      Reflect.getMetadata(METHOD_METADATA, handlerOf(handlerName)) as number,
      Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName)) as string,
    ]);

    expect(routes).toEqual(ROUTE_TABLE.map((route) => [...route]));
    expect(routes).toHaveLength(24);
  });

  it('declares literal paths before :id routes', () => {
    const declaredNames = declaredHandlerNames();
    expect(declaredNames).toEqual(HANDLER_NAMES);

    const declaredPaths = declaredNames.map(
      (handlerName) =>
        Reflect.getMetadata(PATH_METADATA, handlerOf(handlerName)) as string,
    );
    const firstParameterRouteIndex = declaredPaths.findIndex((path) =>
      path.includes('/:'),
    );
    expect(declaredPaths.indexOf('staff')).toBeLessThan(
      firstParameterRouteIndex,
    );
    expect(declaredPaths.indexOf('tasks/due-count')).toBeLessThan(
      firstParameterRouteIndex,
    );
    expect(declaredPaths.indexOf('tasks/due-count')).toBeLessThan(
      declaredPaths.indexOf('tasks/:id'),
    );
  });

  it('answers 200 on comments and assignees and 201 on batches', () => {
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('addComment')),
    ).toBe(HttpStatus.OK);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('assignTask')),
    ).toBe(HttpStatus.OK);
    // A POST with no @HttpCode answers Nest's default 201.
    expect(
      Reflect.getMetadata(METHOD_METADATA, handlerOf('createTaskBatch')),
    ).toBe(RequestMethod.POST);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf('createTaskBatch')),
    ).toBeUndefined();
    for (const handlerName of ['createIdea', 'createTask', 'createGuide']) {
      expect(
        Reflect.getMetadata(HTTP_CODE_METADATA, handlerOf(handlerName)),
      ).toBeUndefined();
    }
  });

  it('binds no pipe to :id, :commentId or :userId', () => {
    for (const handlerName of HANDLER_NAMES) {
      const routeArguments = Object.values(
        (Reflect.getMetadata(
          ROUTE_ARGS_METADATA,
          AdminCulturalProductionController,
          handlerName,
        ) ?? {}) as Record<string, { data?: unknown; pipes?: unknown[] }>,
      );
      for (const routeArgument of routeArguments) {
        expect(routeArgument.pipes ?? []).toEqual([]);
      }
    }
  });
});

describe('AdminCulturalProductionController delegation', () => {
  const idea = { id: IDEA_ID };
  const task = { id: TASK_ID };
  const guide = { id: GUIDE_ID };
  let ideasService: Record<string, jest.Mock>;
  let tasksService: Record<string, jest.Mock>;
  let guidesService: Record<string, jest.Mock>;
  let controller: AdminCulturalProductionController;

  beforeEach(() => {
    ideasService = {
      listIdeas: jest.fn().mockResolvedValue({ items: [], isTruncated: false }),
      createIdea: jest.fn().mockResolvedValue(idea),
      getIdea: jest.fn().mockResolvedValue(idea),
      updateIdea: jest.fn().mockResolvedValue(idea),
      deleteIdea: jest.fn().mockResolvedValue({ ok: true }),
      backIdea: jest.fn().mockResolvedValue(idea),
      unbackIdea: jest.fn().mockResolvedValue(idea),
      addComment: jest.fn().mockResolvedValue(idea),
      deleteComment: jest.fn().mockResolvedValue(idea),
    };
    tasksService = {
      searchStaff: jest.fn().mockResolvedValue({ items: [] }),
      dueCount: jest.fn().mockResolvedValue({ count: 2 }),
      listTasks: jest.fn().mockResolvedValue({ items: [] }),
      createTask: jest.fn().mockResolvedValue(task),
      getTask: jest.fn().mockResolvedValue(task),
      updateTask: jest.fn().mockResolvedValue(task),
      deleteTask: jest.fn().mockResolvedValue({ ok: true }),
      assign: jest.fn().mockResolvedValue(task),
      unassign: jest.fn().mockResolvedValue(task),
      createFromGuide: jest.fn().mockResolvedValue({ items: [task] }),
    };
    guidesService = {
      listGuides: jest.fn().mockResolvedValue({ items: [] }),
      createGuide: jest.fn().mockResolvedValue(guide),
      getGuide: jest.fn().mockResolvedValue(guide),
      replaceGuide: jest.fn().mockResolvedValue(guide),
      deleteGuide: jest.fn().mockResolvedValue({ ok: true }),
    };
    controller = new AdminCulturalProductionController(
      ideasService as unknown as CulturalIdeasService,
      tasksService as unknown as CulturalTasksService,
      guidesService as unknown as CulturalGuidesService,
    );
  });

  it('passes the current user to every service call', async () => {
    const ideaBody = { title: 'Zine swap', eventType: 'other' };
    const commentBody = { body: 'Count me in' };
    const taskBody = { title: 'Book the venue' };
    const listQuery = { assignedTo: 'me', status: 'open' };
    const assignBody = { userId: TARGET_ID };
    const guideBody = { title: 'Quiz night', eventType: 'quiz_night' };
    const replaceBody = { ...guideBody, revision: 3 };
    const batchBody = { eventOn: '2026-12-12', assigneeIds: [TARGET_ID] };

    await controller.searchStaff({ q: 'ana' }, CALLER);
    await controller.dueCount(CALLER);
    await controller.listIdeas(CALLER);
    await controller.createIdea(ideaBody, CALLER);
    await controller.getIdea(IDEA_ID, CALLER);
    await controller.updateIdea(IDEA_ID, ideaBody, CALLER);
    await controller.deleteIdea(IDEA_ID, CALLER);
    await controller.backIdea(IDEA_ID, CALLER);
    await controller.unbackIdea(IDEA_ID, CALLER);
    await controller.addComment(IDEA_ID, commentBody, CALLER);
    await controller.deleteComment(IDEA_ID, COMMENT_ID, CALLER);
    await controller.listTasks(listQuery, CALLER);
    await controller.createTask(taskBody, CALLER);
    await controller.getTask(TASK_ID, CALLER);
    await controller.updateTask(TASK_ID, taskBody, CALLER);
    await controller.deleteTask(TASK_ID, CALLER);
    await controller.assignTask(TASK_ID, assignBody, CALLER);
    await controller.unassignTask(TASK_ID, TARGET_ID, CALLER);
    await controller.listGuides(CALLER);
    await controller.createGuide(guideBody, CALLER);
    await controller.getGuide(GUIDE_ID, CALLER);
    await controller.replaceGuide(GUIDE_ID, replaceBody, CALLER);
    await controller.deleteGuide(GUIDE_ID, CALLER);
    await controller.createTaskBatch(GUIDE_ID, batchBody, CALLER);

    expect(tasksService.searchStaff).toHaveBeenCalledWith('ana', CALLER);
    expect(tasksService.dueCount).toHaveBeenCalledWith(CALLER);
    expect(ideasService.listIdeas).toHaveBeenCalledWith(CALLER);
    expect(ideasService.createIdea).toHaveBeenCalledWith(ideaBody, CALLER);
    expect(ideasService.getIdea).toHaveBeenCalledWith(IDEA_ID, CALLER);
    expect(ideasService.updateIdea).toHaveBeenCalledWith(
      IDEA_ID,
      ideaBody,
      CALLER,
    );
    expect(ideasService.deleteIdea).toHaveBeenCalledWith(IDEA_ID, CALLER);
    expect(ideasService.backIdea).toHaveBeenCalledWith(IDEA_ID, CALLER);
    expect(ideasService.unbackIdea).toHaveBeenCalledWith(IDEA_ID, CALLER);
    expect(ideasService.addComment).toHaveBeenCalledWith(
      IDEA_ID,
      commentBody,
      CALLER,
    );
    expect(ideasService.deleteComment).toHaveBeenCalledWith(
      IDEA_ID,
      COMMENT_ID,
      CALLER,
    );
    expect(tasksService.listTasks).toHaveBeenCalledWith(listQuery, CALLER);
    expect(tasksService.createTask).toHaveBeenCalledWith(taskBody, CALLER);
    expect(tasksService.getTask).toHaveBeenCalledWith(TASK_ID, CALLER);
    expect(tasksService.updateTask).toHaveBeenCalledWith(
      TASK_ID,
      taskBody,
      CALLER,
    );
    expect(tasksService.deleteTask).toHaveBeenCalledWith(TASK_ID, CALLER);
    expect(tasksService.assign).toHaveBeenCalledWith(
      TASK_ID,
      assignBody,
      CALLER,
    );
    expect(tasksService.unassign).toHaveBeenCalledWith(
      TASK_ID,
      TARGET_ID,
      CALLER,
    );
    expect(guidesService.listGuides).toHaveBeenCalledWith(CALLER);
    expect(guidesService.createGuide).toHaveBeenCalledWith(guideBody, CALLER);
    expect(guidesService.getGuide).toHaveBeenCalledWith(GUIDE_ID, CALLER);
    expect(guidesService.replaceGuide).toHaveBeenCalledWith(
      GUIDE_ID,
      replaceBody,
      CALLER,
    );
    expect(guidesService.deleteGuide).toHaveBeenCalledWith(GUIDE_ID, CALLER);
    expect(tasksService.createFromGuide).toHaveBeenCalledWith(
      GUIDE_ID,
      batchBody,
      CALLER,
    );

    const everyServiceMock = [
      ...Object.values(ideasService),
      ...Object.values(tasksService),
      ...Object.values(guidesService),
    ];
    for (const serviceMock of everyServiceMock) {
      expect(serviceMock).toHaveBeenCalledTimes(1);
      const callArguments = serviceMock.mock.calls[0] as unknown[];
      expect(callArguments[callArguments.length - 1]).toBe(CALLER);
    }
  });

  it('answers what the service answers', async () => {
    await expect(controller.getIdea(IDEA_ID, CALLER)).resolves.toBe(idea);
    await expect(controller.getTask(TASK_ID, CALLER)).resolves.toBe(task);
    await expect(controller.getGuide(GUIDE_ID, CALLER)).resolves.toBe(guide);
    await expect(controller.dueCount(CALLER)).resolves.toEqual({ count: 2 });
  });
});
