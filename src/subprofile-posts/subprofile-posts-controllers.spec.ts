import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { PERSONA_SCOPED_KEY_HANDLERS } from '../storage/shared-upload-handlers';
import { UserRole } from '../users/entities/user.entity';
import { AdminPersonaPostsController } from './admin-persona-posts.controller';
import { PersonaPostEditsController } from './persona-post-edits.controller';
import { PersonaPostsController } from './persona-posts.controller';
import { SubprofilePostModerationService } from './subprofile-post-moderation.service';
import { SubprofilePostsModule } from './subprofile-posts.module';

const handlerOf = (
  controller: { prototype: unknown },
  methodName: string,
): object => {
  const handler = (controller.prototype as Record<string, object | undefined>)[
    methodName
  ];
  if (!handler) {
    throw new Error(`No handler named ${methodName} on the controller`);
  }
  return handler;
};

const guardsOf = (target: object): unknown[] =>
  (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];

describe('Persona post controllers', () => {
  it('registers the three controllers in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, SubprofilePostsModule),
    ).toEqual([
      PersonaPostsController,
      PersonaPostEditsController,
      AdminPersonaPostsController,
    ]);
  });

  it('mounts the contract paths', () => {
    expect(Reflect.getMetadata(PATH_METADATA, PersonaPostsController)).toBe(
      'subprofiles',
    );
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        handlerOf(PersonaPostsController, 'listPosts'),
      ),
    ).toBe(':id/posts');
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        handlerOf(PersonaPostsController, 'create'),
      ),
    ).toBe(':id/posts');
    expect(Reflect.getMetadata(PATH_METADATA, PersonaPostEditsController)).toBe(
      'subprofile-posts',
    );
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminPersonaPostsController),
    ).toBe('admin/persona-posts');
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        handlerOf(AdminPersonaPostsController, 'removePost'),
      ),
    ).toBe(':postId/remove');
  });

  it('opens the post list to signed-out visitors with an optional session', () => {
    const listPosts = handlerOf(PersonaPostsController, 'listPosts');
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, listPosts)).toBe(true);
    expect(guardsOf(listPosts)).toEqual([OptionalJwtAuthGuard]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', listPosts)).toBe(30);
  });

  it('binds the restriction check to every write', () => {
    for (const [controller, methodName] of [
      [PersonaPostsController, 'create'],
      [PersonaPostEditsController, 'update'],
      [PersonaPostEditsController, 'remove'],
    ] as const) {
      expect(guardsOf(handlerOf(controller, methodName))).toContain(
        NotRestrictedGuard,
      );
    }
    expect(guardsOf(PersonaPostsController)).toEqual([ActiveMemberGuard]);
    expect(guardsOf(PersonaPostEditsController)).toEqual([ActiveMemberGuard]);
  });

  it('answers 201 to a new post and 204 to a delete and a staff removal', () => {
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(PersonaPostsController, 'create'),
      ),
    ).toBe(201);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(PersonaPostEditsController, 'remove'),
      ),
    ).toBe(204);
    expect(
      Reflect.getMetadata(
        HTTP_CODE_METADATA,
        handlerOf(AdminPersonaPostsController, 'removePost'),
      ),
    ).toBe(204);
  });

  it('opens the staff routes to moderators and admins only', () => {
    expect(guardsOf(AdminPersonaPostsController)).toEqual([
      ActiveMemberGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, AdminPersonaPostsController)).toEqual(
      [UserRole.Moderator, UserRole.Admin],
    );
  });

  it('carries no launch feature tag, like the persona routes', () => {
    for (const controller of [
      PersonaPostsController,
      PersonaPostEditsController,
      AdminPersonaPostsController,
    ]) {
      expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBeUndefined();
    }
  });

  it('passes the staff removal reason and report id through', async () => {
    const moderation = {
      removePost: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new AdminPersonaPostsController(
      moderation as unknown as SubprofilePostModerationService,
    );
    const user = { userId: 'staff-1' } as CurrentUserData;

    await controller.removePost(user, 'post-1', {
      reason: 'Harassment',
      reportId: 'report-1',
    });
    await controller.removePost(user, 'post-2', { reason: 'Spam' });

    expect(moderation.removePost).toHaveBeenNthCalledWith(
      1,
      'staff-1',
      'post-1',
      'Harassment',
      'report-1',
    );
    expect(moderation.removePost).toHaveBeenNthCalledWith(
      2,
      'staff-1',
      'post-2',
      'Spam',
      undefined,
    );
  });

  it('lets the two post writes carry a persona-scoped photo key', () => {
    expect(
      PERSONA_SCOPED_KEY_HANDLERS.has('PersonaPostsController.create'),
    ).toBe(true);
    expect(
      PERSONA_SCOPED_KEY_HANDLERS.has('PersonaPostEditsController.update'),
    ).toBe(true);
  });
});
