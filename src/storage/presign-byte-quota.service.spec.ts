import { HttpException } from '@nestjs/common';
import {
  DAILY_PRESIGN_BYTE_LIMIT,
  PresignByteQuotaService,
} from './presign-byte-quota.service';

const NOON = new Date('2026-11-23T12:00:00.000Z');
const NEXT_DAY = new Date('2026-11-24T00:00:01.000Z');

// SEC-44: one member's presigned bytes per UTC day are capped.
describe('PresignByteQuotaService', () => {
  it('charges up to the limit and refuses past it with the coded 429', () => {
    const quota = new PresignByteQuotaService();
    quota.charge('member-1', DAILY_PRESIGN_BYTE_LIMIT - 10, NOON);
    let refusal: unknown;
    try {
      quota.charge('member-1', 11, NOON);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(HttpException);
    const httpRefusal = refusal as HttpException;
    expect(httpRefusal.getStatus()).toBe(429);
    expect(httpRefusal.getResponse()).toEqual(
      expect.objectContaining({ code: 'UPLOAD_DAILY_QUOTA_REACHED' }),
    );
    expect(() => quota.charge('member-1', 10, NOON)).not.toThrow();
  });

  it('keeps each member to their own allowance', () => {
    const quota = new PresignByteQuotaService();
    quota.charge('member-1', DAILY_PRESIGN_BYTE_LIMIT, NOON);
    expect(() => quota.charge('member-2', 1024, NOON)).not.toThrow();
  });

  it('starts a fresh allowance on the next UTC day', () => {
    const quota = new PresignByteQuotaService();
    quota.charge('member-1', DAILY_PRESIGN_BYTE_LIMIT, NOON);
    expect(() => quota.charge('member-1', 1024, NEXT_DAY)).not.toThrow();
  });

  it('gives a refunded charge back', () => {
    const quota = new PresignByteQuotaService();
    quota.charge('member-1', DAILY_PRESIGN_BYTE_LIMIT, NOON);
    quota.refund('member-1', 2048, NOON);
    expect(() => quota.charge('member-1', 2048, NOON)).not.toThrow();
  });
});
