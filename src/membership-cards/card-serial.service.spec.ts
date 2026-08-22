import { Repository } from 'typeorm';
import { CardSerialService } from './card-serial.service';
import { MembershipCard } from './entities/membership-card.entity';

function repoStub(existingSerials: string[] = []) {
  return {
    findOne: jest.fn(({ where }: { where: { serial: string } }) =>
      Promise.resolve(
        existingSerials.includes(where.serial) ? ({} as MembershipCard) : null,
      ),
    ),
  } as unknown as Repository<MembershipCard>;
}

describe('CardSerialService', () => {
  describe('prefixFor', () => {
    it('takes the first three letters of a single-word name', () => {
      const service = new CardSerialService(repoStub());
      expect(service.prefixFor('Azores')).toBe('AZO');
    });

    it('takes initials when the name has three or more words', () => {
      const service = new CardSerialService(repoStub());
      expect(service.prefixFor('Lisbon Trans Collective')).toBe('LTC');
    });

    it('strips accents and non-letters', () => {
      const service = new CardSerialService(repoStub());
      expect(service.prefixFor('Ação Já!')).toBe('AJ');
    });

    it('falls back to QPC when the name has no letters', () => {
      const service = new CardSerialService(repoStub());
      expect(service.prefixFor('123 !!!')).toBe('QPC');
    });
  });

  describe('generate', () => {
    it('returns PREFIX-XXXXX using the unambiguous alphabet', async () => {
      const service = new CardSerialService(repoStub());
      const serial = await service.generate('AZO');
      expect(serial).toMatch(/^AZO-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{5}$/);
    });

    it('retries when the first candidate is already taken', async () => {
      const repo = repoStub();
      let call = 0;
      (repo.findOne as jest.Mock).mockImplementation(() => {
        call += 1;
        return Promise.resolve(call === 1 ? ({} as MembershipCard) : null);
      });
      const serial = await new CardSerialService(repo).generate('AZO');
      expect(serial).toMatch(/^AZO-/);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(repo.findOne).toHaveBeenCalledTimes(2);
    });

    it('throws after exhausting its retries', async () => {
      const repo = repoStub();
      (repo.findOne as jest.Mock).mockResolvedValue({});
      const service = new CardSerialService(repo);
      await expect(service.generate('AZO')).rejects.toThrow(
        'Could not allocate a unique card serial',
      );
    });
  });
});
