import { BadRequestException } from '@nestjs/common';
import { NudgesService } from './nudges.service';

// Chainable insert-builder stub (dismiss uses
// `.insert().into().values().orIgnore().execute()`).
function insertQbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['insert', 'into', 'values', 'orIgnore']) {
    qb[method] = jest.fn().mockReturnValue(qb);
  }
  qb.execute = jest.fn().mockResolvedValue(undefined);
  return qb;
}

function build(existingRows: { nudgeKey: string }[] = []) {
  const insertQb = insertQbStub();
  const nudges = {
    createQueryBuilder: jest.fn().mockReturnValue(insertQb),
    find: jest.fn().mockResolvedValue(existingRows),
  };
  const service = new NudgesService(nudges as never);
  return { service, nudges, insertQb };
}

describe('NudgesService', () => {
  describe('myNudges', () => {
    it('reports the caller dismissed keys, not capped below 2', async () => {
      const { service } = build([{ nudgeKey: 'profile_empty' }]);

      await expect(service.myNudges('user-1')).resolves.toEqual({
        dismissedKeys: ['profile_empty'],
        capped: false,
      });
    });

    it('caps at 2 distinct dismissals', async () => {
      const { service } = build([
        { nudgeKey: 'profile_empty' },
        { nudgeKey: 'directory_footer' },
      ]);

      await expect(service.myNudges('user-1')).resolves.toEqual({
        dismissedKeys: ['profile_empty', 'directory_footer'],
        capped: true,
      });
    });
  });

  describe('dismiss', () => {
    it('inserts once, idempotently, via ON CONFLICT DO NOTHING', async () => {
      const { service, insertQb } = build([{ nudgeKey: 'profile_empty' }]);

      const result = await service.dismiss('user-1', 'profile_empty');

      expect(insertQb.values).toHaveBeenCalledWith({
        userId: 'user-1',
        nudgeKey: 'profile_empty',
      });
      expect(insertQb.orIgnore).toHaveBeenCalled(); // ON CONFLICT DO NOTHING
      expect(insertQb.execute).toHaveBeenCalledTimes(1);
      expect(result).toEqual({
        dismissedKeys: ['profile_empty'],
        capped: false,
      });
    });

    it('re-dismissing the same key stays a single row (idempotent)', async () => {
      // Simulates the DB state after the unique constraint absorbed a repeat
      // insert: `find` still returns only the one prior row.
      const { service, nudges, insertQb } = build([
        { nudgeKey: 'profile_empty' },
      ]);

      await service.dismiss('user-1', 'profile_empty');

      expect(nudges.find).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
        select: { nudgeKey: true },
      });
      expect(insertQb.execute).toHaveBeenCalledTimes(1);
    });

    it('capped flips true at the 2nd distinct dismissed key', async () => {
      const { service } = build([
        { nudgeKey: 'profile_empty' },
        { nudgeKey: 'directory_footer' },
      ]);

      const result = await service.dismiss('user-1', 'directory_footer');

      expect(result.capped).toBe(true);
    });

    it('rejects an unknown nudge key with 400, without inserting', async () => {
      const { service, insertQb } = build();

      await expect(
        service.dismiss('user-1', 'not_a_real_nudge'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(insertQb.execute).not.toHaveBeenCalled();
    });
  });
});
