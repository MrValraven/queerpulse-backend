import { BadRequestException, ParseEnumPipe } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminCreatorDraftsController } from './admin-creator-drafts.controller';
import { AdminCreatorDraftsService } from './admin-creator-drafts.service';
import { CREATOR_DRAFT_KIND_VALUES } from './creator-drafts.constants';
import { ListAdminCreatorDraftsQuery } from './dto/list-admin-creator-drafts.query';

const DRAFT_ID = '44444444-4444-4444-8444-444444444444';

describe('AdminCreatorDraftsController', () => {
  let service: { list: jest.Mock; getOne: jest.Mock };
  let controller: AdminCreatorDraftsController;

  beforeEach(() => {
    service = {
      list: jest.fn(),
      getOne: jest.fn().mockResolvedValue({ id: DRAFT_ID }),
    };
    controller = new AdminCreatorDraftsController(
      service as unknown as AdminCreatorDraftsService,
    );
  });

  it('is Admin only, with no moderator tier, no staff roles and no class feature', () => {
    expect(
      Reflect.getMetadata(ROLES_KEY, AdminCreatorDraftsController),
    ).toEqual([UserRole.Admin]);
    expect(
      Reflect.getMetadata(GUARDS_METADATA, AdminCreatorDraftsController),
    ).toEqual([ActiveMemberGuard, RolesGuard]);
    expect(
      Reflect.getMetadata(FEATURE_KEY, AdminCreatorDraftsController),
    ).toBeUndefined();
    expect(
      Reflect.getMetadata(PATH_METADATA, AdminCreatorDraftsController),
    ).toBe('admin/creator-drafts');
    // Read off the prototype as a plain object so the unbound-method rule
    // has nothing to say.
    const getOneHandler = (
      AdminCreatorDraftsController.prototype as unknown as Record<
        string,
        object | undefined
      >
    ).getOne;
    if (getOneHandler === undefined) {
      throw new Error('getOne handler is missing from the prototype');
    }
    expect(Reflect.getMetadata(PATH_METADATA, getOneHandler)).toBe(':kind/:id');
  });

  it('refuses an unknown kind through the enum pipe', async () => {
    // The pipe types its input as the enum object; a raw path segment is what it receives at runtime.
    await expect(
      new ParseEnumPipe(CREATOR_DRAFT_KIND_VALUES).transform(
        'drafts' as never,
        {
          type: 'param',
        },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('passes the caller, the kind and the id to the service', async () => {
    await controller.getOne(
      { userId: 'admin-1' } as CurrentUserData,
      'event',
      DRAFT_ID,
    );
    expect(service.getOne).toHaveBeenCalledWith('admin-1', 'event', DRAFT_ID);
  });

  it('refuses a page above the cap and a kind outside the list', async () => {
    const errorsFor = async (query: object) =>
      validate(plainToInstance(ListAdminCreatorDraftsQuery, query));
    expect(await errorsFor({ page: '10001' })).not.toHaveLength(0);
    expect(await errorsFor({ page: '0' })).not.toHaveLength(0);
    expect(await errorsFor({ kind: 'drafts' })).not.toHaveLength(0);
    expect(await errorsFor({ kind: 'studio_episode', page: '2' })).toHaveLength(
      0,
    );
  });
});
