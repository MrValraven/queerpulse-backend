import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Namespace } from 'socket.io';
import { Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { PlatformSettingsService } from '../platform-settings/platform-settings.service';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import {
  MAX_WATCHED_PIECES_PER_SOCKET,
  MagazineDeskPresenceGateway,
} from './magazine-desk-presence.gateway';
import { MagazineDeskPresenceService } from './magazine-desk-presence.service';

type GatewayClient = Parameters<
  MagazineDeskPresenceGateway['handleConnection']
>[0];

interface FakeClient {
  id: string;
  connected: boolean;
  handshake: {
    auth: { token?: string };
    headers: Record<string, string | undefined>;
  };
  data: Record<string, unknown>;
  emit: jest.Mock;
  disconnect: jest.Mock;
  join: jest.Mock;
  leave: jest.Mock;
}

function makeClient(socketId: string): FakeClient {
  return {
    id: socketId,
    connected: true,
    handshake: { auth: { token: 'access-token' }, headers: {} },
    data: {},
    emit: jest.fn(),
    disconnect: jest.fn(),
    join: jest.fn().mockResolvedValue(undefined),
    leave: jest.fn().mockResolvedValue(undefined),
  };
}

function asClient(client: FakeClient): GatewayClient {
  return client as unknown as GatewayClient;
}

describe('MagazineDeskPresenceGateway', () => {
  let jwt: { verifyAsync: jest.Mock };
  let users: { findOne: jest.Mock };
  let staffRoles: { exists: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let refreshTokens: { exists: jest.Mock };
  let platformSettings: { get: jest.Mock };
  let roomEmit: jest.Mock;
  let disconnectSockets: jest.Mock;
  let presence: MagazineDeskPresenceService;
  let gateway: MagazineDeskPresenceGateway;

  function staffUser(role: UserRole) {
    users.findOne.mockResolvedValue({
      id: 'user-1',
      role,
      status: UserStatus.Active,
    });
  }

  function lockdown(isModeratorAllowed: boolean) {
    platformSettings.get.mockResolvedValue({
      lockdownEnabled: true,
      lockdownAllowsModerators: isModeratorAllowed,
    });
  }

  beforeEach(() => {
    jwt = {
      verifyAsync: jest.fn().mockResolvedValue({
        sub: 'user-1',
        status: UserStatus.Active,
        exp: Math.floor(Date.now() / 1000) + 900,
      }),
    };
    users = { findOne: jest.fn() };
    staffRoles = { exists: jest.fn().mockResolvedValue(true) };
    profiles = {
      findOne: jest.fn().mockResolvedValue({
        userId: 'user-1',
        firstName: 'Marta',
        lastName: 'Cruz',
        avatarUrl: null,
      }),
    };
    refreshTokens = { exists: jest.fn().mockResolvedValue(true) };
    platformSettings = {
      get: jest.fn().mockResolvedValue({
        lockdownEnabled: false,
        lockdownAllowsModerators: false,
      }),
    };
    roomEmit = jest.fn();
    disconnectSockets = jest.fn();
    presence = new MagazineDeskPresenceService();
    gateway = new MagazineDeskPresenceGateway(
      jwt as unknown as JwtService,
      { getOrThrow: () => 'secret' } as unknown as ConfigService,
      presence,
      users as unknown as Repository<User>,
      staffRoles as unknown as Repository<UserStaffRole>,
      profiles as unknown as Repository<Profile>,
      refreshTokens as unknown as Repository<RefreshToken>,
      platformSettings as unknown as PlatformSettingsService,
    );
    gateway.namespace = {
      to: jest.fn().mockReturnValue({ emit: roomEmit }),
      disconnectSockets,
    } as unknown as Namespace;
    staffUser(UserRole.Member);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    presence.onModuleDestroy();
  });

  describe('handshake admission', () => {
    it('admits a magazine editor and records the viewer', async () => {
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      expect(client.disconnect).not.toHaveBeenCalled();
      expect(client.data.viewer).toEqual({
        userId: 'user-1',
        name: 'Marta Cruz',
        initials: 'MC',
      });
    });

    it('refuses a member without the magazine_editor grant', async () => {
      staffRoles.exists.mockResolvedValue(false);
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(client.data.viewer).toBeUndefined();
    });

    it('refuses a banned account even while its token claims active', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Suspended,
      });
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      expect(client.disconnect).toHaveBeenCalledWith(true);
    });

    it('refuses a member-tier editor during a lockdown', async () => {
      lockdown(true);
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      expect(client.disconnect).toHaveBeenCalledWith(true);
      expect(refreshTokens.exists).not.toHaveBeenCalled();
    });

    it('admits an admin during a lockdown', async () => {
      lockdown(false);
      staffUser(UserRole.Admin);
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      expect(client.disconnect).not.toHaveBeenCalled();
    });

    it('admits a moderator only when the lockdown allows moderators', async () => {
      staffUser(UserRole.Moderator);
      lockdown(false);
      const refusedClient = makeClient('socket-1');
      await gateway.handleConnection(asClient(refusedClient));
      expect(refusedClient.disconnect).toHaveBeenCalledWith(true);

      lockdown(true);
      const admittedClient = makeClient('socket-2');
      await gateway.handleConnection(asClient(admittedClient));
      expect(admittedClient.disconnect).not.toHaveBeenCalled();
    });

    it('rate limits handshakes per verified user before any database read', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await gateway.handleConnection(
          asClient(makeClient(`socket-${attempt}`)),
        );
      }
      users.findOne.mockClear();

      const throttledClient = makeClient('socket-throttled');
      await gateway.handleConnection(asClient(throttledClient));

      expect(throttledClient.disconnect).toHaveBeenCalledWith(true);
      expect(users.findOne).not.toHaveBeenCalled();
    });

    it('drops every socket when a lockdown is enabled', () => {
      gateway.handleLockdownEnabled({ actorId: 'admin-1' });
      expect(disconnectSockets).toHaveBeenCalledWith(true);
    });
  });

  describe('piece:watch cap', () => {
    it('holds the cap under a burst of frames', async () => {
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));

      const pieceIds = Array.from(
        { length: MAX_WATCHED_PIECES_PER_SOCKET + 4 },
        (_unused, index) => `piece-${index}`,
      );
      const results = await Promise.allSettled(
        pieceIds.map((pieceId) =>
          gateway.handlePieceWatch(asClient(client), { pieceId }),
        ),
      );

      expect(presence.watchedPieceCount('socket-1')).toBe(
        MAX_WATCHED_PIECES_PER_SOCKET,
      );
      const refusals = results.filter(
        (result) =>
          result.status === 'rejected' && result.reason instanceof WsException,
      );
      expect(refusals).toHaveLength(4);
    });

    it('lets a socket at the cap re-watch a piece it already holds', async () => {
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      for (let index = 0; index < MAX_WATCHED_PIECES_PER_SOCKET; index += 1) {
        await gateway.handlePieceWatch(asClient(client), {
          pieceId: `piece-${index}`,
        });
      }

      await expect(
        gateway.handlePieceWatch(asClient(client), { pieceId: 'piece-0' }),
      ).resolves.toBeUndefined();
      expect(presence.watchedPieceCount('socket-1')).toBe(
        MAX_WATCHED_PIECES_PER_SOCKET,
      );
    });

    it('answers only the joining socket when the list did not change', async () => {
      const client = makeClient('socket-1');
      await gateway.handleConnection(asClient(client));
      await gateway.handlePieceWatch(asClient(client), { pieceId: 'piece-1' });
      roomEmit.mockClear();

      await gateway.handlePieceWatch(asClient(client), { pieceId: 'piece-1' });

      expect(roomEmit).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith('piece:viewers', {
        pieceId: 'piece-1',
        viewers: [{ userId: 'user-1', name: 'Marta Cruz', initials: 'MC' }],
      });
    });
  });
});
