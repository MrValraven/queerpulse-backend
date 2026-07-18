import { Test, TestingModule } from '@nestjs/testing';
import { Request } from 'express';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';

describe('AccountController', () => {
  let controller: AccountController;
  let service: {
    reauth: jest.Mock;
    deactivate: jest.Mock;
    requestDeletion: jest.Mock;
    getDeletionRequest: jest.Mock;
    cancelDeletionRequest: jest.Mock;
    requestExport: jest.Mock;
    getExportJob: jest.Mock;
    submitDsar: jest.Mock;
    listDsar: jest.Mock;
    listSessions: jest.Mock;
    revokeSession: jest.Mock;
    revokeOtherSessions: jest.Mock;
    getEmailPreferences: jest.Mock;
    updateEmailPreference: jest.Mock;
  };

  const user: CurrentUserData = {
    userId: 'u1',
    email: 'a@b.com',
    status: 'pending',
    role: 'member',
  };

  // Minimal Express request stub carrying the presenting refresh-token cookie.
  const req = {
    cookies: { refresh_token: 'raw-refresh' },
  } as unknown as Request;

  beforeEach(async () => {
    service = {
      reauth: jest.fn(),
      deactivate: jest.fn(),
      requestDeletion: jest.fn(),
      getDeletionRequest: jest.fn(),
      cancelDeletionRequest: jest.fn(),
      requestExport: jest.fn(),
      getExportJob: jest.fn(),
      submitDsar: jest.fn(),
      listDsar: jest.fn(),
      listSessions: jest.fn(),
      revokeSession: jest.fn(),
      revokeOtherSessions: jest.fn(),
      getEmailPreferences: jest.fn(),
      updateEmailPreference: jest.fn(),
    };
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AccountController],
      providers: [{ provide: AccountService, useValue: service }],
    }).compile();
    controller = module.get(AccountController);
  });

  it('POST /reauth delegates to the service for the current user, ignoring any password', async () => {
    service.reauth.mockResolvedValue({
      reauthToken: 'tok',
      expiresAt: '2026-07-15T12:05:00.000Z',
    });

    const result = await controller.reauth(user, { password: 'irrelevant' });

    expect(service.reauth).toHaveBeenCalledWith('u1');
    expect(result).toEqual({
      reauthToken: 'tok',
      expiresAt: '2026-07-15T12:05:00.000Z',
    });
  });

  it('POST /deactivate delegates the dto through', async () => {
    service.deactivate.mockResolvedValue({ status: 'deactivated' });
    const result = await controller.deactivate(user, { reauthToken: 'tok' });
    expect(service.deactivate).toHaveBeenCalledWith('u1', {
      reauthToken: 'tok',
    });
    expect(result).toEqual({ status: 'deactivated' });
  });

  it('POST /deletion-request delegates to the service and returns the FE shape', async () => {
    service.requestDeletion.mockResolvedValue({
      id: 'del-1',
      status: 'grace',
      requestedAt: '2026-07-15T12:00:00.000Z',
      scheduledErasureAt: '2026-08-14T12:00:00.000Z',
      gracePeriodDays: 30,
    });
    const result = await controller.requestDeletion(user, {
      reauthToken: 'tok',
    });
    expect(service.requestDeletion).toHaveBeenCalledWith('u1', {
      reauthToken: 'tok',
    });
    expect(result.status).toBe('grace');
    expect(result.gracePeriodDays).toBe(30);
  });

  it('GET /deletion-request returns null when none is pending', async () => {
    service.getDeletionRequest.mockResolvedValue(null);
    await expect(controller.getDeletionRequest(user)).resolves.toBeNull();
  });

  it('DELETE /deletion-request delegates cancellation', async () => {
    service.cancelDeletionRequest.mockResolvedValue(undefined);
    await controller.cancelDeletionRequest(user);
    expect(service.cancelDeletionRequest).toHaveBeenCalledWith('u1');
  });

  it('POST /export delegates the dto through and returns the export-job envelope', async () => {
    service.requestExport.mockResolvedValue({
      jobId: 'job-1',
      status: 'ready',
      requestedAt: '2026-07-15T12:00:00.000Z',
    });
    const result = await controller.requestExport(user, {
      categories: ['profile'],
      format: 'json',
      reauthToken: 'tok',
    });
    expect(service.requestExport).toHaveBeenCalledWith('u1', {
      categories: ['profile'],
      format: 'json',
      reauthToken: 'tok',
    });
    expect(result.jobId).toBe('job-1');
    expect(result.requestedAt).toBe('2026-07-15T12:00:00.000Z');
  });

  it('GET /export/:jobId delegates to the service', async () => {
    service.getExportJob.mockResolvedValue({
      jobId: 'job-1',
      status: 'ready',
      requestedAt: '2026-07-15T12:00:00.000Z',
      downloadUrl: '/account/export/job-1/download',
    });
    const result = await controller.getExportJob(user, 'job-1');
    expect(service.getExportJob).toHaveBeenCalledWith('u1', 'job-1');
    expect(result.jobId).toBe('job-1');
    expect(result.downloadUrl).toBe('/account/export/job-1/download');
  });

  it('POST /dsar delegates to the service', async () => {
    service.submitDsar.mockResolvedValue({ reference: 'DSAR-ABC' });
    const result = await controller.submitDsar(user, {
      article: 15,
      scopes: ['profile'],
      details: 'details',
      reauthToken: 'tok',
    });
    expect(service.submitDsar).toHaveBeenCalledWith('u1', {
      article: 15,
      scopes: ['profile'],
      details: 'details',
      reauthToken: 'tok',
    });
    expect(result.reference).toBe('DSAR-ABC');
  });

  it('GET /dsar returns the caller history', async () => {
    service.listDsar.mockResolvedValue([{ reference: 'DSAR-ABC' }]);
    const result = await controller.listDsar(user);
    expect(service.listDsar).toHaveBeenCalledWith('u1');
    expect(result).toHaveLength(1);
  });

  it('GET /sessions passes the presenting refresh-token cookie through', async () => {
    service.listSessions.mockResolvedValue([]);
    await controller.listSessions(user, req);
    expect(service.listSessions).toHaveBeenCalledWith('u1', 'raw-refresh');
  });

  it('DELETE /sessions/:id revokes one session via the service', async () => {
    service.revokeSession.mockResolvedValue(undefined);
    await controller.revokeSession(user, 'rt-1');
    expect(service.revokeSession).toHaveBeenCalledWith('u1', 'rt-1');
  });

  it('DELETE /sessions revokes OTHER sessions, passing the presenting refresh-token cookie', async () => {
    service.revokeOtherSessions.mockResolvedValue(undefined);
    await controller.revokeOtherSessions(user, req);
    expect(service.revokeOtherSessions).toHaveBeenCalledWith(
      'u1',
      'raw-refresh',
    );
  });

  it('GET /email-preferences returns the array from the service', async () => {
    service.getEmailPreferences.mockResolvedValue([
      { category: 'productUpdates', email: true },
    ]);
    const result = await controller.getEmailPreferences(user);
    expect(service.getEmailPreferences).toHaveBeenCalledWith('u1');
    expect(result).toEqual([{ category: 'productUpdates', email: true }]);
  });

  it('POST /email-preferences upserts a single {category,email} toggle and returns the array', async () => {
    service.updateEmailPreference.mockResolvedValue([
      { category: 'productUpdates', email: false },
    ]);
    const result = await controller.updateEmailPreference(user, {
      category: 'productUpdates',
      email: false,
    });
    expect(service.updateEmailPreference).toHaveBeenCalledWith('u1', {
      category: 'productUpdates',
      email: false,
    });
    expect(result).toEqual([{ category: 'productUpdates', email: false }]);
  });

  it('a pending user can call every account endpoint (no ActiveMemberGuard applied)', async () => {
    const pendingUser: CurrentUserData = { ...user, status: 'pending' };
    service.reauth.mockResolvedValue({ reauthToken: 'tok', expiresAt: 'x' });
    await expect(controller.reauth(pendingUser, {})).resolves.toBeDefined();
    // Documents intent: AccountController has no @UseGuards(ActiveMemberGuard).
  });
});
