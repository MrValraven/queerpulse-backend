import { Repository } from 'typeorm';
import { User, UserStatus } from '../users/entities/user.entity';
import { CalendarFeedTokenService } from './calendar-feed-token.service';
import { CalendarFeedToken } from './entities/calendar-feed-token.entity';

const VALID_TOKEN = 'a'.repeat(64);
const OWNER_ID = 'owner-1';

interface TokenRepositoryMock {
  findOne: jest.Mock;
  update: jest.Mock;
}

interface UserRepositoryMock {
  findOne: jest.Mock;
}

function buildService(ownerStatus: UserStatus | null): {
  service: CalendarFeedTokenService;
  tokens: TokenRepositoryMock;
} {
  const tokens: TokenRepositoryMock = {
    findOne: jest
      .fn()
      .mockResolvedValue({ id: 'row-1', userId: OWNER_ID, token: VALID_TOKEN }),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const users: UserRepositoryMock = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        ownerStatus === null ? null : { id: OWNER_ID, status: ownerStatus },
      ),
  };
  const service = new CalendarFeedTokenService(
    tokens as unknown as Repository<CalendarFeedToken>,
    users as unknown as Repository<User>,
  );
  return { service, tokens };
}

describe('CalendarFeedTokenService.verify (SEC-18)', () => {
  it('resolves the owner of a live token for an active member', async () => {
    const { service, tokens } = buildService(UserStatus.Active);
    await expect(service.verify(VALID_TOKEN)).resolves.toBe(OWNER_ID);
    expect(tokens.update).toHaveBeenCalled();
  });

  it.each([UserStatus.Suspended, UserStatus.Deactivated])(
    'serves nothing for a %s account',
    async (status) => {
      const { service, tokens } = buildService(status);
      await expect(service.verify(VALID_TOKEN)).resolves.toBeNull();
      expect(tokens.update).not.toHaveBeenCalled();
    },
  );

  it('serves nothing when the owner row is gone', async () => {
    const { service } = buildService(null);
    await expect(service.verify(VALID_TOKEN)).resolves.toBeNull();
  });

  it('rejects a malformed token without touching the database', async () => {
    const { service, tokens } = buildService(UserStatus.Active);
    await expect(service.verify('not-a-token')).resolves.toBeNull();
    expect(tokens.findOne).not.toHaveBeenCalled();
  });
});
