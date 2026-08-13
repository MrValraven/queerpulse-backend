import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  BULK_ACTION_CAP,
  BulkDecideVerificationRequestsDto,
} from './bulk-decide-verification-requests.dto';

const check = (payload: Record<string, unknown>) =>
  validate(plainToInstance(BulkDecideVerificationRequestsDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

const validUuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

describe('BulkDecideVerificationRequestsDto', () => {
  it('accepts a well-formed approve payload', async () => {
    const errors = await check({
      ids: [validUuid(1), validUuid(2)],
      action: 'approve',
    });
    expect(errors).toHaveLength(0);
  });

  it('accepts an optional reason', async () => {
    const errors = await check({
      ids: [validUuid(1)],
      action: 'reject',
      reason: 'evidence does not match the profile',
    });
    expect(errors).toHaveLength(0);
  });

  it('rejects an empty ids array', async () => {
    const errors = await check({ ids: [], action: 'approve' });
    expect(errors.some((error) => error.property === 'ids')).toBe(true);
  });

  it(`accepts exactly ${BULK_ACTION_CAP} ids (the cap)`, async () => {
    const ids = Array.from({ length: BULK_ACTION_CAP }, (_, index) =>
      validUuid(index + 1),
    );
    const errors = await check({ ids, action: 'approve' });
    expect(errors).toHaveLength(0);
  });

  it(`rejects ${BULK_ACTION_CAP + 1} ids — over the cap`, async () => {
    const ids = Array.from({ length: BULK_ACTION_CAP + 1 }, (_, index) =>
      validUuid(index + 1),
    );
    const errors = await check({ ids, action: 'approve' });
    expect(errors.some((error) => error.property === 'ids')).toBe(true);
  });

  it('rejects a non-UUID id', async () => {
    const errors = await check({ ids: ['not-a-uuid'], action: 'approve' });
    expect(errors.some((error) => error.property === 'ids')).toBe(true);
  });

  it('rejects an unknown action', async () => {
    const errors = await check({ ids: [validUuid(1)], action: 'delete' });
    expect(errors.some((error) => error.property === 'action')).toBe(true);
  });

  it('rejects an unwhitelisted field', async () => {
    const errors = await check({
      ids: [validUuid(1)],
      action: 'approve',
      extra: 'nope',
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
