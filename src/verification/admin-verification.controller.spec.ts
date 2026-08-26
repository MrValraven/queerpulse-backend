import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AdminVerificationController } from './admin-verification.controller';
import { BulkDecideVerificationRequestsDto } from './dto/bulk-decide-verification-requests.dto';
import { DecideVerificationRequestDto } from './dto/decide-verification-request.dto';
import { ListAdminVerificationsQuery } from './dto/list-admin-verifications.query';
import { ListVerificationRequestsQuery } from './dto/list-verification-requests.query';
import { OverrideVerificationDto } from './dto/override-verification.dto';
import { MemberVerification } from './entities/member-verification.entity';
import { VerificationRequestStatus } from './verification-request-status';
import {
  VerificationEventAction,
  VerificationGrantedBy,
  VerificationLevel,
  VerificationType,
} from './verification-level';
import { VerificationService } from './verification.service';

describe('AdminVerificationController', () => {
  let controller: AdminVerificationController;
  let service: {
    listForAdmin: jest.Mock;
    listHistoryDTO: jest.Mock;
    override: jest.Mock;
    getMemberRef: jest.Mock;
    listRequestsForAdmin: jest.Mock;
    requestDetailDTO: jest.Mock;
    decideRequest: jest.Mock;
    bulkDecide: jest.Mock;
  };

  const currentUser: CurrentUserData = {
    userId: 'admin-1',
    email: 'admin@queerpulse.test',
    status: 'active',
    role: 'admin',
  };

  const member = {
    slug: 'devon-brooks',
    firstName: 'Devon',
    lastName: 'Brooks',
    pronouns: 'they/them',
    avatarUrl: null,
  };

  beforeEach(async () => {
    service = {
      listForAdmin: jest.fn(),
      listHistoryDTO: jest.fn(),
      override: jest.fn(),
      getMemberRef: jest.fn(),
      listRequestsForAdmin: jest.fn(),
      requestDetailDTO: jest.fn(),
      decideRequest: jest.fn(),
      bulkDecide: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AdminVerificationController],
      providers: [{ provide: VerificationService, useValue: service }],
    }).compile();
    controller = module.get(AdminVerificationController);
  });

  it('is guarded by @Roles(Moderator, Admin)', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      AdminVerificationController,
    ) as UserRole[];
    expect(roles).toEqual([UserRole.Moderator, UserRole.Admin]);
  });

  describe('GET /admin/verifications', () => {
    it('maps the query DTO to the service filter and returns counts keyed by level', async () => {
      const query: ListAdminVerificationsQuery = {
        level: VerificationLevel.Phone,
        q: 'devon',
        sort: 'level',
        cursor: 'opaque-cursor',
      };
      const listResult = {
        rows: [],
        counts: {
          [VerificationLevel.None]: 0,
          [VerificationLevel.Email]: 4,
          [VerificationLevel.Phone]: 2,
          [VerificationLevel.IdVerified]: 1,
        },
        nextCursor: null,
      };
      service.listForAdmin.mockResolvedValue(listResult);

      const result = await controller.list(query);

      // `q` on the query DTO maps to `query` on the service filter — the
      // one field renamed crossing the HTTP boundary.
      expect(service.listForAdmin).toHaveBeenCalledWith({
        level: VerificationLevel.Phone,
        query: 'devon',
        sort: 'level',
        cursor: 'opaque-cursor',
      });
      expect(result).toBe(listResult);
      expect(result.counts).toEqual(
        expect.objectContaining({
          [VerificationLevel.Email]: 4,
          [VerificationLevel.Phone]: 2,
        }),
      );
    });

    it('forwards an empty filter (no q/level/sort/cursor) unchanged', async () => {
      const listResult = { rows: [], counts: {}, nextCursor: null };
      service.listForAdmin.mockResolvedValue(listResult);

      await controller.list({});

      expect(service.listForAdmin).toHaveBeenCalledWith({
        level: undefined,
        query: undefined,
        sort: undefined,
        cursor: undefined,
        assignedTo: undefined,
      });
    });
  });

  describe('GET /admin/verifications/:userId/history', () => {
    it("returns the service's events mapped to DTOs with actor hydrated", async () => {
      const history = [
        {
          id: 'event-1',
          action: VerificationEventAction.Overridden,
          fromLevel: VerificationLevel.Phone,
          toLevel: VerificationLevel.IdVerified,
          reason: null,
          actor: member,
          createdAt: '2026-08-13T00:00:00.000Z',
        },
      ];
      service.listHistoryDTO.mockResolvedValue(history);

      const result = await controller.history('member-1');

      expect(service.listHistoryDTO).toHaveBeenCalledWith('member-1');
      expect(result).toBe(history);
      expect(result[0]?.actor).toEqual(member);
    });
  });

  describe('PATCH /admin/verifications/:userId', () => {
    it("forwards the current user's id as actorUserId and dto.note as reason, and hand-maps the response", async () => {
      const dto: OverrideVerificationDto = {
        level: VerificationLevel.IdVerified,
        note: 'duplicate account resolved, re-granting',
      };
      // What `override` actually returns today — the RAW entity, including
      // internal-only fields (`id`, `type`, `grantedBy`, `reviewedByUserId`,
      // `createdAt`) that must never reach the response body.
      const rawEntity: MemberVerification = {
        id: 'row-1',
        userId: 'member-1',
        level: VerificationLevel.IdVerified,
        method: 'manual_review',
        provider: 'admin',
        providerRef: null,
        verifiedAt: new Date('2026-08-13T00:00:00.000Z'),
        type: VerificationType.Identity,
        grantedBy: VerificationGrantedBy.AdminGranted,
        reviewedByUserId: 'admin-1',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      };
      service.override.mockResolvedValue(rawEntity);
      service.getMemberRef.mockResolvedValue(member);

      const result = await controller.override('member-1', dto, currentUser);

      expect(service.override).toHaveBeenCalledWith(
        'member-1',
        VerificationLevel.IdVerified,
        'admin-1',
        'duplicate account resolved, re-granting',
      );
      expect(service.getMemberRef).toHaveBeenCalledWith('member-1');
      // Hand-mapped, not the raw entity: only the DTO's fields survive, and
      // internal-only entity fields are gone.
      expect(result).toEqual({
        userId: 'member-1',
        member,
        level: VerificationLevel.IdVerified,
        method: 'manual_review',
        provider: 'admin',
        providerRef: null,
        verifiedAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      });
      expect(result).not.toHaveProperty('reviewedByUserId');
      expect(result).not.toHaveProperty('grantedBy');
      expect(result).not.toHaveProperty('type');
      expect(result).not.toHaveProperty('id');
    });
  });

  describe('GET /admin/verifications/requests', () => {
    it('maps the query DTO to the service filter (q -> query) and returns counts keyed by status', async () => {
      const query: ListVerificationRequestsQuery = {
        status: VerificationRequestStatus.Pending,
        type: VerificationType.Identity,
        q: 'devon',
        sort: 'oldest',
        cursor: 'opaque-cursor',
      };
      const listResult = {
        rows: [],
        counts: {
          [VerificationRequestStatus.Pending]: 3,
          [VerificationRequestStatus.InReview]: 1,
          [VerificationRequestStatus.Approved]: 5,
          [VerificationRequestStatus.Rejected]: 2,
          [VerificationRequestStatus.Appealing]: 1,
          [VerificationRequestStatus.Withdrawn]: 0,
        },
        nextCursor: null,
      };
      service.listRequestsForAdmin.mockResolvedValue(listResult);

      const result = await controller.listRequests(currentUser, query);

      expect(service.listRequestsForAdmin).toHaveBeenCalledWith({
        status: VerificationRequestStatus.Pending,
        type: VerificationType.Identity,
        query: 'devon',
        sort: 'oldest',
        cursor: 'opaque-cursor',
        // OPS-04: no `assignedTo` on the query, so no narrowing is forwarded.
        assignedTo: undefined,
      });
      expect(result).toBe(listResult);
      expect(result.counts).toEqual(
        expect.objectContaining({
          [VerificationRequestStatus.Pending]: 3,
          [VerificationRequestStatus.Appealing]: 1,
        }),
      );
    });

    it('forwards an empty filter (no status/type/q/sort/cursor) unchanged', async () => {
      const listResult = { rows: [], counts: {}, nextCursor: null };
      service.listRequestsForAdmin.mockResolvedValue(listResult);

      await controller.listRequests(currentUser, {});

      expect(service.listRequestsForAdmin).toHaveBeenCalledWith({
        status: undefined,
        type: undefined,
        query: undefined,
        sort: undefined,
        cursor: undefined,
      });
    });
  });

  describe('POST /admin/verifications/requests/bulk', () => {
    it("forwards ids/action/reason and the current user's id as actorUserId, returning the service's result untouched", async () => {
      const dto: BulkDecideVerificationRequestsDto = {
        ids: ['request-1', 'request-2'],
        action: 'reject',
        reason: 'evidence does not match the profile',
      };
      const bulkResult = {
        succeeded: ['request-1'],
        failed: [{ id: 'request-2', reason: 'Cannot move from "withdrawn"' }],
      };
      service.bulkDecide.mockResolvedValue(bulkResult);

      const result = await controller.bulkDecide(dto, currentUser);

      expect(service.bulkDecide).toHaveBeenCalledWith(
        ['request-1', 'request-2'],
        'admin-1',
        'reject',
        'evidence does not match the profile',
      );
      expect(result).toBe(bulkResult);
    });

    it('forwards an approve/in_review payload with no reason as undefined', async () => {
      const dto: BulkDecideVerificationRequestsDto = {
        ids: ['request-1'],
        action: 'approve',
      };
      service.bulkDecide.mockResolvedValue({ succeeded: [], failed: [] });

      await controller.bulkDecide(dto, currentUser);

      expect(service.bulkDecide).toHaveBeenCalledWith(
        ['request-1'],
        'admin-1',
        'approve',
        undefined,
      );
    });
  });

  describe('GET /admin/verifications/requests/:id', () => {
    it('returns the detail DTO, including member, reviewedBy, signals, and history', async () => {
      const detail = {
        id: 'request-1',
        member,
        type: VerificationType.Identity,
        requestedLevel: VerificationLevel.Phone,
        status: VerificationRequestStatus.Rejected,
        isAppeal: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
        context: 'I run the Tuesday hiking meetup, ask anyone there.',
        evidenceRef: 'https://example.com/my-profile',
        decisionReason: 'Could not corroborate the evidence link',
        reviewedBy: member,
        signals: { accountAgeDays: 42, duplicateEvidenceRef: false },
        history: [
          {
            id: 'event-1',
            action: VerificationEventAction.Rejected,
            fromLevel: null,
            toLevel: null,
            reason: 'Could not corroborate the evidence link',
            actor: member,
            createdAt: '2026-08-13T00:00:00.000Z',
          },
        ],
      };
      service.requestDetailDTO.mockResolvedValue(detail);

      const result = await controller.requestDetail('request-1');

      expect(service.requestDetailDTO).toHaveBeenCalledWith('request-1');
      expect(result).toBe(detail);
      expect(result.member).toEqual(member);
      expect(result.reviewedBy).toEqual(member);
      expect(result.signals).toEqual({
        accountAgeDays: 42,
        duplicateEvidenceRef: false,
      });
      expect(result.history).toHaveLength(1);
    });
  });

  describe('PATCH /admin/verifications/requests/:id', () => {
    it('forwards actor + action + reason to decideRequest and hand-maps the response', async () => {
      const dto: DecideVerificationRequestDto = {
        action: 'reject',
        reason: 'Could not corroborate the evidence link',
      };
      // What `decideRequest` actually returns — the RAW `VerificationRequest`
      // entity, including reviewer-only fields that must not leak into the
      // hand-mapped `AdminVerificationRequestDTO` response (the admin LIST
      // row shape omits context/signals/decisionReason too — that's the
      // detail endpoint's job).
      const rawRequest = {
        id: 'request-1',
        userId: 'member-1',
        type: VerificationType.Identity,
        requestedLevel: VerificationLevel.Phone,
        status: VerificationRequestStatus.Rejected,
        context: 'I run the Tuesday hiking meetup, ask anyone there.',
        evidenceRef: 'https://example.com/my-profile',
        decisionReason: 'Could not corroborate the evidence link',
        reviewedByUserId: 'admin-1',
        reviewedBy: null,
        signals: { accountAgeDays: 42 },
        isAppeal: false,
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      };
      service.decideRequest.mockResolvedValue(rawRequest);
      service.getMemberRef.mockResolvedValue(member);

      const result = await controller.decideRequest(
        'request-1',
        dto,
        currentUser,
      );

      expect(service.decideRequest).toHaveBeenCalledWith(
        'request-1',
        'admin-1',
        'reject',
        'Could not corroborate the evidence link',
      );
      expect(service.getMemberRef).toHaveBeenCalledWith('member-1');
      expect(result).toEqual({
        id: 'request-1',
        member,
        type: VerificationType.Identity,
        requestedLevel: VerificationLevel.Phone,
        status: VerificationRequestStatus.Rejected,
        isAppeal: false,
        createdAt: '2026-08-12T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
        // No `duplicateProviderRef` on this row's signals snapshot.
        hasDuplicateSignal: false,
      });
      // Reviewer-only / detail-only fields never reach the list-row response
      // — the raw `signals` object itself never leaks, only the derived flag.
      expect(result).not.toHaveProperty('context');
      expect(result).not.toHaveProperty('evidenceRef');
      expect(result).not.toHaveProperty('decisionReason');
      expect(result).not.toHaveProperty('reviewedByUserId');
      expect(result).not.toHaveProperty('signals');
      expect(result).not.toHaveProperty('userId');
    });

    it('sets hasDuplicateSignal from the row snapshot without leaking the raw signals object', async () => {
      const dto: DecideVerificationRequestDto = { action: 'in_review' };
      const rawRequest = {
        id: 'request-2',
        userId: 'member-1',
        type: VerificationType.Identity,
        requestedLevel: VerificationLevel.Phone,
        status: VerificationRequestStatus.InReview,
        context: null,
        evidenceRef: null,
        decisionReason: null,
        reviewedByUserId: null,
        reviewedBy: null,
        signals: {
          accountAgeDays: 5,
          priorRejections: 0,
          duplicateProviderRef: { count: 2, userIds: ['member-9', 'member-8'] },
        },
        isAppeal: false,
        createdAt: new Date('2026-08-12T00:00:00.000Z'),
        updatedAt: new Date('2026-08-13T00:00:00.000Z'),
      };
      service.decideRequest.mockResolvedValue(rawRequest);
      service.getMemberRef.mockResolvedValue(member);

      const result = await controller.decideRequest(
        'request-2',
        dto,
        currentUser,
      );

      expect(result.hasDuplicateSignal).toBe(true);
      expect(result).not.toHaveProperty('signals');
    });
  });
});
