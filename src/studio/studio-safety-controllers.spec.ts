import {
  GUARDS_METADATA,
  HTTP_CODE_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { FEATURE_KEY } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminStudioCopyrightClaimsController } from './admin-studio-copyright-claims.controller';
import { AdminStudioTracksController } from './admin-studio-tracks.controller';
import { StudioClaimantRole } from './entities/studio-copyright-claim.entity';
import { StudioAccessGuard } from './studio-access.guard';
import { StudioAdminTracksService } from './studio-admin-tracks.service';
import { StudioClaimsAdminService } from './studio-claims-admin.service';
import { StudioClaimsController } from './studio-claims.controller';
import { StudioClaimsService } from './studio-claims.service';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';
import { StudioModule } from './studio.module';

const THROTTLE_LIMIT_KEY = 'THROTTLER:LIMITdefault';
const THROTTLE_TTL_KEY = 'THROTTLER:TTLdefault';
const USER: CurrentUserData = {
  userId: 'd0000000-0000-4000-8000-000000000001',
} as CurrentUserData;
const CLAIM_ID = 'd0100000-0000-4000-8000-000000000001';
const TRACK_ID = 'd0200000-0000-4000-8000-000000000001';
const REPORT_ID = 'd0300000-0000-4000-8000-000000000001';

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

describe('Studio safety controllers', () => {
  it.each([
    StudioClaimsController,
    AdminStudioCopyrightClaimsController,
    AdminStudioTracksController,
  ])('tags %p with the studio feature', (controller) => {
    expect(Reflect.getMetadata(FEATURE_KEY, controller)).toBe('studio');
  });

  describe('member routes', () => {
    it('guards every route with the active member check alone at class level', () => {
      expect(guardsOf(StudioClaimsController)).toEqual([ActiveMemberGuard]);
      expect(Reflect.getMetadata(PATH_METADATA, StudioClaimsController)).toBe(
        '/',
      );
    });

    it.each([
      [
        'file',
        'studio/tracks/:id/copyright-claims',
        [StudioAccessGuard, NotRestrictedGuard],
        3,
        3600000,
        undefined,
      ],
      [
        'listMine',
        'me/studio/copyright-claims',
        [],
        undefined,
        undefined,
        undefined,
      ],
      ['reply', 'me/studio/copyright-claims/:id/reply', [], 5, 300000, 200],
      [
        'withdraw',
        'me/studio/copyright-claims/:id/withdraw',
        [],
        5,
        300000,
        200,
      ],
      [
        'counter',
        'studio/copyright-claims/:id/counter',
        [StudioAccessGuard],
        5,
        300000,
        200,
      ],
    ])(
      '%s answers %s with its guards, throttle and status',
      (methodName, path, guards, limit, ttl, httpCode) => {
        const handler = handlerOf(StudioClaimsController, methodName);
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
        expect(guardsOf(handler)).toEqual(guards);
        expect(Reflect.getMetadata(THROTTLE_LIMIT_KEY, handler)).toBe(limit);
        expect(Reflect.getMetadata(THROTTLE_TTL_KEY, handler)).toBe(ttl);
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(httpCode);
      },
    );

    it('passes each call through with the caller', async () => {
      const service = {
        file: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        listMine: jest.fn().mockResolvedValue({ items: [] }),
        reply: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        withdraw: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        counter: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
      };
      const controller = new StudioClaimsController(
        service as unknown as StudioClaimsService,
      );
      const body = {
        claimantRole: StudioClaimantRole.RightsHolder,
        originalWork: 'Saudade',
        details: 'The hook',
        goodFaith: true as const,
      };

      await controller.file(USER, TRACK_ID, body);
      await controller.listMine(USER, { cursor: 'next' });
      await controller.reply(USER, CLAIM_ID, { reply: 'No' });
      await controller.withdraw(USER, CLAIM_ID);
      await controller.counter(USER, CLAIM_ID, {
        note: 'I wrote it',
        goodFaith: true,
      });

      expect(service.file).toHaveBeenCalledWith(USER.userId, TRACK_ID, body);
      expect(service.listMine).toHaveBeenCalledWith(USER.userId, 'next');
      expect(service.reply).toHaveBeenCalledWith(USER.userId, CLAIM_ID, 'No');
      expect(service.withdraw).toHaveBeenCalledWith(USER.userId, CLAIM_ID);
      expect(service.counter).toHaveBeenCalledWith(
        USER.userId,
        CLAIM_ID,
        'I wrote it',
      );
    });
  });

  describe('staff routes', () => {
    it.each([
      AdminStudioCopyrightClaimsController,
      AdminStudioTracksController,
    ])(
      'opens %p to moderators and admins only, with no Studio grant',
      (controller) => {
        expect(guardsOf(controller)).toEqual([ActiveMemberGuard, RolesGuard]);
        expect(Reflect.getMetadata(ROLES_KEY, controller)).toEqual([
          UserRole.Moderator,
          UserRole.Admin,
        ]);
        expect(controller.name.startsWith('Admin')).toBe(true);
      },
    );

    it('serves the claims queue, its counts and the four decisions', () => {
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          AdminStudioCopyrightClaimsController,
        ),
      ).toBe('admin/studio/copyright-claims');
      const methodNames = Object.getOwnPropertyNames(
        AdminStudioCopyrightClaimsController.prototype,
      ).filter((methodName) => methodName !== 'constructor');
      expect(methodNames).toEqual([
        'listClaims',
        'countClaims',
        'accept',
        'decline',
        'uphold',
        'reject',
      ]);
      expect(
        Reflect.getMetadata(
          PATH_METADATA,
          handlerOf(AdminStudioCopyrightClaimsController, 'countClaims'),
        ),
      ).toBe('counts');
      for (const methodName of ['accept', 'decline', 'uphold', 'reject']) {
        const handler = handlerOf(
          AdminStudioCopyrightClaimsController,
          methodName,
        );
        expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(
          `:id/${methodName}`,
        );
        expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
      }
    });

    it('passes staff decisions through with the actor and the note', async () => {
      const service = {
        list: jest.fn().mockResolvedValue({ items: [] }),
        counts: jest.fn().mockResolvedValue({ submitted: 0, countered: 0 }),
        accept: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        decline: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        uphold: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
        reject: jest.fn().mockResolvedValue({ id: CLAIM_ID }),
      };
      const controller = new AdminStudioCopyrightClaimsController(
        service as unknown as StudioClaimsAdminService,
      );

      await controller.listClaims({});
      await controller.countClaims();
      await controller.accept(USER, CLAIM_ID);
      await controller.decline(USER, CLAIM_ID, { note: 'Thin' });
      await controller.uphold(USER, CLAIM_ID, { note: 'Clear copy' });
      await controller.reject(USER, CLAIM_ID, { note: 'Licensed' });

      expect(service.list).toHaveBeenCalledWith(undefined, undefined);
      expect(service.counts).toHaveBeenCalled();
      expect(service.accept).toHaveBeenCalledWith(USER.userId, CLAIM_ID);
      expect(service.decline).toHaveBeenCalledWith(
        USER.userId,
        CLAIM_ID,
        'Thin',
      );
      expect(service.uphold).toHaveBeenCalledWith(
        USER.userId,
        CLAIM_ID,
        'Clear copy',
      );
      expect(service.reject).toHaveBeenCalledWith(
        USER.userId,
        CLAIM_ID,
        'Licensed',
      );
    });

    it('serves the staff track read and the two track actions', async () => {
      expect(
        Reflect.getMetadata(PATH_METADATA, AdminStudioTracksController),
      ).toBe('admin/studio/tracks');
      for (const [methodName, path] of [
        ['getTrack', ':id'],
        ['markExplicit', ':id/mark-explicit'],
        ['addContentWarnings', ':id/content-warnings'],
      ]) {
        expect(
          Reflect.getMetadata(
            PATH_METADATA,
            handlerOf(AdminStudioTracksController, methodName!),
          ),
        ).toBe(path);
      }
      const service = {
        getTrack: jest.fn().mockResolvedValue({ id: TRACK_ID }),
        markExplicit: jest.fn().mockResolvedValue({ id: TRACK_ID }),
        addContentWarnings: jest.fn().mockResolvedValue({ id: TRACK_ID }),
      };
      const controller = new AdminStudioTracksController(
        service as unknown as StudioAdminTracksService,
      );

      await controller.getTrack(TRACK_ID);
      await controller.markExplicit(USER, TRACK_ID, { reportId: REPORT_ID });
      await controller.addContentWarnings(USER, TRACK_ID, {
        warnings: ['police'],
      });

      expect(service.getTrack).toHaveBeenCalledWith(TRACK_ID);
      expect(service.markExplicit).toHaveBeenCalledWith(
        USER.userId,
        TRACK_ID,
        REPORT_ID,
      );
      expect(service.addContentWarnings).toHaveBeenCalledWith(
        USER.userId,
        TRACK_ID,
        ['police'],
        undefined,
      );
    });
  });

  it('registers the safety controllers and providers in the module', () => {
    expect(
      Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioClaimsController,
        AdminStudioCopyrightClaimsController,
        AdminStudioTracksController,
      ]),
    );
    expect(
      Reflect.getMetadata(MODULE_METADATA.PROVIDERS, StudioModule),
    ).toEqual(
      expect.arrayContaining([
        StudioClaimsService,
        StudioClaimsAdminService,
        StudioAdminTracksService,
        StudioSafetyNoticesService,
      ]),
    );
  });
});
