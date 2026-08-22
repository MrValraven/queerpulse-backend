import { Test, TestingModule } from '@nestjs/testing';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { IdentityCallbackDto } from './dto/identity-callback.dto';
import { SubmitVerificationRequestDto } from './dto/submit-verification-request.dto';
import { VerificationRequestStatus } from './verification-request-status';
import { VerificationLevel, VerificationType } from './verification-level';
import { VerificationController } from './verification.controller';
import { VerificationService } from './verification.service';

describe('VerificationController', () => {
  let controller: VerificationController;
  let service: {
    getStatus: jest.Mock;
    latestRequestFor: jest.Mock;
    submitRequest: jest.Mock;
    withdrawRequest: jest.Mock;
    appealRequest: jest.Mock;
    startIdentity: jest.Mock;
    handleIdentityCallback: jest.Mock;
  };

  const currentUser: CurrentUserData = {
    userId: 'member-1',
    email: 'member@queerpulse.test',
    status: 'active',
    role: 'member',
  };

  const status = {
    level: VerificationLevel.Email,
    phoneVerified: false,
    idVerified: false,
    method: null,
    provider: null,
    verifiedAt: null,
  };

  // What the service's request lifecycle methods actually return — the RAW
  // `VerificationRequest` entity, including reviewer-only fields
  // (`reviewedByUserId`, `signals`) that must never survive the controller's
  // hand-mapping into the wire response.
  const rawRequest = {
    id: 'request-1',
    userId: 'member-1',
    type: VerificationType.Identity,
    requestedLevel: VerificationLevel.Phone,
    status: VerificationRequestStatus.Pending,
    context: 'I run the Tuesday hiking meetup, ask anyone there.',
    evidenceRef: 'https://example.com/my-profile',
    decisionReason: null,
    reviewedByUserId: 'admin-9',
    reviewedBy: null,
    signals: { accountAgeDays: 42 },
    isAppeal: false,
    createdAt: new Date('2026-08-13T00:00:00.000Z'),
    updatedAt: new Date('2026-08-13T00:00:00.000Z'),
  };

  beforeEach(async () => {
    service = {
      getStatus: jest.fn(),
      latestRequestFor: jest.fn(),
      submitRequest: jest.fn(),
      withdrawRequest: jest.fn(),
      appealRequest: jest.fn(),
      startIdentity: jest.fn(),
      handleIdentityCallback: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [VerificationController],
      providers: [{ provide: VerificationService, useValue: service }],
    }).compile();
    controller = module.get(VerificationController);
  });

  describe('GET /verification/me', () => {
    it('merges status + latestRequest, mapped and leak-free', async () => {
      service.getStatus.mockResolvedValue(status);
      service.latestRequestFor.mockResolvedValue(rawRequest);

      const result = await controller.getMine(currentUser);

      expect(service.getStatus).toHaveBeenCalledWith('member-1');
      expect(service.latestRequestFor).toHaveBeenCalledWith('member-1');
      expect(result).toEqual({
        ...status,
        latestRequest: {
          id: 'request-1',
          type: VerificationType.Identity,
          requestedLevel: VerificationLevel.Phone,
          status: VerificationRequestStatus.Pending,
          context: 'I run the Tuesday hiking meetup, ask anyone there.',
          decisionReason: null,
          isAppeal: false,
          createdAt: '2026-08-13T00:00:00.000Z',
          updatedAt: '2026-08-13T00:00:00.000Z',
        },
      });
      // Reviewer-only fields never reach the member.
      expect(result.latestRequest).not.toHaveProperty('reviewedByUserId');
      expect(result.latestRequest).not.toHaveProperty('signals');
      expect(result.latestRequest).not.toHaveProperty('evidenceRef');
    });

    it('returns latestRequest: null when the member has never submitted one', async () => {
      service.getStatus.mockResolvedValue(status);
      service.latestRequestFor.mockResolvedValue(null);

      const result = await controller.getMine(currentUser);

      expect(result.latestRequest).toBeNull();
    });
  });

  describe('POST /verification/requests', () => {
    it("creates a request via the service with the authed member's id", async () => {
      const dto: SubmitVerificationRequestDto = {
        requestedLevel: VerificationLevel.Phone,
        context: 'I run the Tuesday hiking meetup, ask anyone there.',
        evidenceRef: 'https://example.com/my-profile',
      };
      service.submitRequest.mockResolvedValue(rawRequest);

      const result = await controller.submitRequest(currentUser, dto);

      expect(service.submitRequest).toHaveBeenCalledWith('member-1', dto);
      expect(result).not.toHaveProperty('reviewedByUserId');
      expect(result).not.toHaveProperty('signals');
      expect(result).not.toHaveProperty('evidenceRef');
      expect(result.status).toBe(VerificationRequestStatus.Pending);
    });
  });

  describe('POST /verification/requests/:id/withdraw', () => {
    it("forwards the authed member's id and the request id", async () => {
      const withdrawn = {
        ...rawRequest,
        status: VerificationRequestStatus.Withdrawn,
      };
      service.withdrawRequest.mockResolvedValue(withdrawn);

      const result = await controller.withdrawRequest(currentUser, 'request-1');

      expect(service.withdrawRequest).toHaveBeenCalledWith(
        'member-1',
        'request-1',
      );
      expect(result.status).toBe(VerificationRequestStatus.Withdrawn);
      expect(result).not.toHaveProperty('reviewedByUserId');
      expect(result).not.toHaveProperty('signals');
    });
  });

  describe('POST /verification/requests/:id/appeal', () => {
    it("forwards the authed member's id and the request id", async () => {
      const appealed = {
        ...rawRequest,
        status: VerificationRequestStatus.Appealing,
        isAppeal: true,
      };
      service.appealRequest.mockResolvedValue(appealed);

      const result = await controller.appealRequest(currentUser, 'request-1');

      expect(service.appealRequest).toHaveBeenCalledWith(
        'member-1',
        'request-1',
      );
      expect(result.status).toBe(VerificationRequestStatus.Appealing);
      expect(result.isAppeal).toBe(true);
      expect(result).not.toHaveProperty('reviewedByUserId');
      expect(result).not.toHaveProperty('signals');
    });
  });

  describe('GET /verification/identity/... (unchanged Phase 1 wiring)', () => {
    it('startIdentity forwards the authed member id', async () => {
      service.startIdentity.mockResolvedValue({
        redirectUrl: 'https://provider.test/session',
        providerRef: 'ref-1',
      });

      await controller.startIdentity(currentUser);

      expect(service.startIdentity).toHaveBeenCalledWith('member-1');
    });

    it('identityCallback forwards the raw payload (unauthenticated webhook seam)', async () => {
      const dto: IdentityCallbackDto = {
        providerRef: 'ref-1',
        status: 'verified',
      };
      service.handleIdentityCallback.mockResolvedValue({ received: true });

      await controller.identityCallback(dto);

      expect(service.handleIdentityCallback).toHaveBeenCalledWith(dto);
    });
  });
});
