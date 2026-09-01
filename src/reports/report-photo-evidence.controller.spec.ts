import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Response } from 'express';
import { StorageService } from '../storage/storage.service';
import { Report, ReportSubjectType } from './entities/report.entity';
import { ReportPhotoEvidenceController } from './report-photo-evidence.controller';

const REPORT_ID = '3d2f8a10-9c4b-4d6e-8f01-2a3b4c5d6e7f';
const PHOTO_KEY =
  'gathering-photos/11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg';

function photoSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    type: 'photo-snapshot',
    photoId: '7f1c0e2a-3b4d-4e5f-8a9b-0c1d2e3f4a5b',
    eventId: 'b2c3d4e5-6f70-4812-9a3b-4c5d6e7f8091',
    storageKey: PHOTO_KEY,
    caption: null,
    uploaderId: '11111111-2222-4333-8444-555555555555',
    uploadedAt: '2026-08-20T21:30:00.000Z',
    snapshotAt: '2026-08-20T22:00:00.000Z',
    ...overrides,
  };
}

describe('ReportPhotoEvidenceController', () => {
  let controller: ReportPhotoEvidenceController;
  let reports: { findOne: jest.Mock };
  let storage: { headObject: jest.Mock; createPresignedDownload: jest.Mock };
  let response: {
    setHeader: jest.Mock;
    redirect: jest.Mock;
  };

  beforeEach(async () => {
    reports = { findOne: jest.fn().mockResolvedValue(null) };
    storage = {
      headObject: jest
        .fn()
        .mockResolvedValue({ contentType: 'image/jpeg', contentLength: 1024 }),
      createPresignedDownload: jest
        .fn()
        .mockResolvedValue('https://bucket.example/signed'),
    };
    response = { setHeader: jest.fn(), redirect: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [ReportPhotoEvidenceController],
      providers: [
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    controller = module.get(ReportPhotoEvidenceController);
  });

  const serve = () =>
    controller.serve(REPORT_ID, response as unknown as Response);

  it('redirects a moderator to a short-lived presigned URL for the reported photo', async () => {
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.EventPhoto,
      evidence: [
        { type: 'url', value: 'https://example.test' },
        photoSnapshot(),
      ],
    });

    await serve();

    expect(storage.createPresignedDownload).toHaveBeenCalledWith(PHOTO_KEY);
    expect(response.redirect).toHaveBeenCalledWith(
      302,
      'https://bucket.example/signed',
    );
    // Specific to who is asking, so no shared or browser cache may keep it.
    expect(response.setHeader).toHaveBeenCalledWith(
      'Cache-Control',
      'private, no-store',
    );
  });

  // The whole point of the report-scoped route: the key is resolved from the
  // report, never accepted from the caller, so a moderator reaches exactly the
  // photos reported to them and no other gathering photo on the platform.
  it('refuses a report that is not about a gathering photo', async () => {
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.Post,
      evidence: [photoSnapshot()],
    });

    await expect(serve()).rejects.toThrow(NotFoundException);
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
  });

  it('refuses a report filed before the snapshot existed', async () => {
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.EventPhoto,
      evidence: [{ type: 'screenshot', uploadId: 'upload-1' }],
    });

    await expect(serve()).rejects.toThrow(NotFoundException);
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
  });

  // A `jsonb` value is not a promise. A snapshot naming some other kind's key
  // must not turn a moderation route into a general-purpose object reader.
  it('refuses a snapshot whose key is not a gathering photo', async () => {
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.EventPhoto,
      evidence: [
        photoSnapshot({
          storageKey:
            'avatars/11111111-2222-4333-8444-555555555555/66666666-7777-4888-8999-aaaaaaaaaaaa.jpg',
        }),
      ],
    });

    await expect(serve()).rejects.toThrow(NotFoundException);
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
  });

  // The photo is held by reference, so the uploader can delete it out from
  // under an open report. The moderator must get an honest "gone" rather than a
  // presigned URL that renders as a broken image they cannot tell from an
  // outage. The report itself stays actionable on the snapshot's facts.
  it('answers 404 rather than a broken image when the photo has been deleted', async () => {
    reports.findOne.mockResolvedValue({
      id: REPORT_ID,
      subjectType: ReportSubjectType.EventPhoto,
      evidence: [photoSnapshot()],
    });
    storage.headObject.mockRejectedValue(new Error('NoSuchKey'));

    await expect(serve()).rejects.toThrow(NotFoundException);
    expect(storage.createPresignedDownload).not.toHaveBeenCalled();
  });

  it('answers 404 for a report id that does not exist', async () => {
    reports.findOne.mockResolvedValue(null);

    await expect(serve()).rejects.toThrow(NotFoundException);
  });
});
