import { Logger, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Request, Response } from 'express';
import { PassThrough } from 'node:stream';
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
    getExportDownload: jest.Mock;
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
      getExportDownload: jest.fn(),
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

  describe('GET /export/:jobId/download', () => {
    // A response stub that is a real writable stream, so the zip path is
    // exercised through `archive.pipe(res)` for real rather than against a
    // mock that cannot apply backpressure.
    type ResponseStub = Response & {
      set: jest.Mock;
      headers: Record<string, string>;
      collected: () => Buffer;
    };

    function responseStub(): ResponseStub {
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on('data', (c: Buffer) => chunks.push(c));
      const headers: Record<string, string> = {};
      return Object.assign(sink, {
        headers,
        collected: () => Buffer.concat(chunks),
        set: jest.fn((key: unknown, value?: unknown) => {
          if (typeof key === 'string') {
            headers[key] = String(value);
          } else {
            Object.assign(headers, key as Record<string, string>);
          }
          return sink;
        }),
      }) as unknown as ResponseStub;
    }

    it('serves format json as a single .json with a Content-Length', async () => {
      const body = Buffer.from('{"a":1}', 'utf8');
      service.getExportDownload.mockResolvedValue({
        kind: 'json',
        filename: 'queerpulse-export-job-1.json',
        contentType: 'application/json',
        body,
      });
      const res = responseStub();
      await controller.downloadExport(user, 'job-1', res);

      expect(service.getExportDownload).toHaveBeenCalledWith('u1', 'job-1');
      expect(res.headers['Content-Type']).toBe('application/json');
      expect(res.headers['Content-Disposition']).toBe(
        'attachment; filename="queerpulse-export-job-1.json"',
      );
      expect(res.headers['Content-Length']).toBe(String(body.byteLength));
      // The archive is personal data — no proxy or browser cache may keep it.
      expect(res.headers['Cache-Control']).toBe('no-store');
      expect(res.collected().toString('utf8')).toBe('{"a":1}');
    });

    it('serves format csv/both as a streamed .zip with no Content-Length', async () => {
      service.getExportDownload.mockResolvedValue({
        kind: 'zip',
        filename: 'queerpulse-export-job-1.zip',
        contentType: 'application/zip',
        entries: [
          { name: 'messages.csv', content: '\uFEFFid\r\nm1\r\n' },
          { name: 'manifest.json', content: '{}' },
        ],
        modifiedAt: new Date('2026-07-15T12:00:00.000Z'),
      });
      const res = responseStub();
      await controller.downloadExport(user, 'job-1', res);

      expect(res.headers['Content-Type']).toBe('application/zip');
      expect(res.headers['Content-Disposition']).toBe(
        'attachment; filename="queerpulse-export-job-1.zip"',
      );
      // Deliberately absent: the deflated size is unknown until the last block,
      // and pre-computing it would mean buffering the whole archive.
      expect(res.headers['Content-Length']).toBeUndefined();

      const zip = res.collected();
      // Local file header magic — this really is a zip, not a JSON blob with a
      // zip content type.
      expect(zip.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
      // Entry names survive into the central directory.
      expect(zip.includes(Buffer.from('messages.csv'))).toBe(true);
      expect(zip.includes(Buffer.from('manifest.json'))).toBe(true);
    });

    it('produces a byte-identical zip for the same job twice', async () => {
      const download = {
        kind: 'zip' as const,
        filename: 'queerpulse-export-job-1.zip',
        contentType: 'application/zip' as const,
        entries: [{ name: 'messages.csv', content: '\uFEFFid\r\nm1\r\n' }],
        modifiedAt: new Date('2026-07-15T12:00:00.000Z'),
      };
      service.getExportDownload.mockResolvedValue(download);
      const first = responseStub();
      await controller.downloadExport(user, 'job-1', first);
      const second = responseStub();
      await controller.downloadExport(user, 'job-1', second);
      // Only true because entry mtimes are pinned to `modifiedAt`.
      expect(first.collected()).toEqual(second.collected());
    });

    it('never writes headers when the job is missing or not the caller’s', async () => {
      // Ownership/readiness is resolved BEFORE any byte is written, which is
      // the only window in which a failure can still be a 404 rather than a
      // truncated download.
      service.getExportDownload.mockRejectedValue(
        new NotFoundException('Export job not found'),
      );
      const res = responseStub();
      await expect(
        controller.downloadExport(user, 'job-1', res),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(res.set).not.toHaveBeenCalled();
      expect(res.collected()).toHaveLength(0);
    });

    it('destroys the socket instead of throwing when the stream fails mid-flight', async () => {
      // Headers are already on the wire, so there is no status code left to
      // change. Aborting the chunked response is what makes the client see a
      // failed download rather than a valid-looking truncated zip.
      service.getExportDownload.mockResolvedValue({
        kind: 'zip',
        filename: 'queerpulse-export-job-1.zip',
        contentType: 'application/zip',
        entries: [{ name: 'messages.csv', content: 'id\r\nm1\r\n' }],
        modifiedAt: new Date('2026-07-15T12:00:00.000Z'),
      });
      const res = responseStub();
      const destroy = jest.spyOn(res, 'destroy');
      const logError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);

      // Fail the socket on the first byte archiver hands us — i.e. strictly
      // after the response headers have been committed.
      const socketError = new Error('socket closed');
      res.write = jest.fn(() => {
        res.emit('error', socketError);
        return false;
      });

      // Resolves — it must NOT reject. A rejection here would hand Nest's
      // exception filter a response it can no longer write to, producing a
      // "Cannot set headers after they are sent" crash on top of the original
      // failure.
      await expect(
        controller.downloadExport(user, 'job-1', res),
      ).resolves.toBeUndefined();

      expect(res.headers['Content-Type']).toBe('application/zip');
      expect(destroy).toHaveBeenCalledWith(socketError);
      expect(logError).toHaveBeenCalledWith(
        expect.stringContaining('Export archive stream failed'),
        expect.anything(),
      );
      logError.mockRestore();
    });
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
