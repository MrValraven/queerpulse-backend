import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminLegalRequestsController } from './admin-legal-requests.controller';
import { CreateLegalRequestDto } from './dto/create-legal-request.dto';
import { UpdateLegalRequestDto } from './dto/update-legal-request.dto';
import { VoidLegalRequestDto } from './dto/void-legal-request.dto';
import {
  LegalRequestOutcome,
  LegalRequestType,
} from './legal-request-vocabulary';
import { LegalRequestsService } from './legal-requests.service';

/**
 * An execution context whose CLASS is the real controller, so `RolesGuard`
 * reads the `@Roles` metadata actually decorating it. Nothing here is mocked
 * except the request's user, which is the thing under test.
 */
const listHandler = Object.getOwnPropertyDescriptor(
  AdminLegalRequestsController.prototype,
  'list',
)?.value as unknown;

function contextFor(user: unknown): ExecutionContext {
  return {
    getHandler: () => listHandler,
    getClass: () => AdminLegalRequestsController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('AdminLegalRequestsController', () => {
  let controller: AdminLegalRequestsController;
  let service: {
    list: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    voidRecord: jest.Mock;
  };

  const actingAdmin: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@example.com',
    status: 'active',
    role: UserRole.Admin,
  };

  beforeEach(async () => {
    service = {
      list: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      voidRecord: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminLegalRequestsController],
      providers: [{ provide: LegalRequestsService, useValue: service }],
    }).compile();
    controller = module.get(AdminLegalRequestsController);
  });

  describe('who can reach it', () => {
    it('is guarded by @Roles(UserRole.Admin) and nothing wider', () => {
      const roles = Reflect.getMetadata(
        ROLES_KEY,
        AdminLegalRequestsController,
      ) as UserRole[];
      expect(roles).toEqual([UserRole.Admin]);
      expect(roles).not.toContain(UserRole.Moderator);
    });

    // The register names state bodies and the members they came for. The
    // moderation rota is a far wider group than the people who should be able
    // to read a police file, so a moderator is refused explicitly rather than
    // merely being absent from the allowed list.
    it.each([
      ['a moderator', UserRole.Moderator],
      ['a member', UserRole.Member],
    ])('refuses %s', (_label, role) => {
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(contextFor({ role }))).toBe(false);
    });

    it('refuses an anonymous caller', () => {
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(contextFor(undefined))).toBe(false);
    });

    it('admits an admin', () => {
      const guard = new RolesGuard(new Reflector());
      expect(guard.canActivate(contextFor({ role: UserRole.Admin }))).toBe(
        true,
      );
    });
  });

  describe('routes', () => {
    it('GET / delegates to list with the query', async () => {
      const page = { items: [], total: 0, page: 1, pageSize: 20 };
      service.list.mockResolvedValue(page);

      const result = await controller.list({ state: 'active' });

      expect(service.list).toHaveBeenCalledWith({ state: 'active' });
      expect(result).toBe(page);
    });

    it('GET /:id delegates to findOne with the id', async () => {
      const record = { id: 'request-1' };
      service.findOne.mockResolvedValue(record);

      const result = await controller.findOne('request-1');

      expect(service.findOne).toHaveBeenCalledWith('request-1');
      expect(result).toBe(record);
    });

    it('POST / delegates to create with the acting admin and the body', async () => {
      const dto: CreateLegalRequestDto = {
        requestingBody: 'District Court of Lisbon',
        jurisdiction: 'Portugal',
        requestType: LegalRequestType.CourtOrder,
        receivedOn: '2026-08-04',
      };
      const created = { id: 'request-1' };
      service.create.mockResolvedValue(created);

      const result = await controller.create(actingAdmin, dto);

      expect(service.create).toHaveBeenCalledWith('admin-1', dto);
      expect(result).toBe(created);
    });

    it('PATCH /:id delegates to update with the id and body', async () => {
      const dto: UpdateLegalRequestDto = {
        outcome: LegalRequestOutcome.Refused,
      };
      const updated = { id: 'request-1' };
      service.update.mockResolvedValue(updated);

      const result = await controller.update('request-1', dto);

      expect(service.update).toHaveBeenCalledWith('request-1', dto);
      expect(result).toBe(updated);
    });

    it('POST /:id/void delegates to voidRecord with the id, admin and reason', async () => {
      const dto: VoidLegalRequestDto = {
        reason: 'Entered against the wrong row',
      };
      const voided = { id: 'request-1', isVoided: true };
      service.voidRecord.mockResolvedValue(voided);

      const result = await controller.voidRecord('request-1', actingAdmin, dto);

      expect(service.voidRecord).toHaveBeenCalledWith(
        'request-1',
        'admin-1',
        dto,
      );
      expect(result).toBe(voided);
    });

    // The register is append-and-amend only. A delete route would let the
    // published figures be emptied without the count of voided records moving.
    it('exposes no delete route', () => {
      const routeNames = Object.getOwnPropertyNames(
        AdminLegalRequestsController.prototype,
      );
      expect(routeNames).toEqual(
        expect.arrayContaining([
          'list',
          'findOne',
          'create',
          'update',
          'voidRecord',
        ]),
      );
      expect(routeNames).not.toContain('remove');
      expect(routeNames).not.toContain('delete');
    });
  });
});
