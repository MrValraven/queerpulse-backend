import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import {
  ChatSessionEnforcementService,
  SESSION_SWEEP_INTERVAL_MS,
} from './chat-session-enforcement.service';
import { PresenceService } from './presence.service';
import { UsersService } from '../users/users.service';
import { UserStatus } from '../users/entities/user.entity';
import { USER_SESSION_REVOKED } from './session.events';

describe('ChatSessionEnforcementService', () => {
  describe('revalidateLiveSessions', () => {
    let presence: { onlineUserIds: jest.Mock };
    let users: { findStatusesByIds: jest.Mock };
    let eventEmitter: { emit: jest.Mock };
    let service: ChatSessionEnforcementService;

    beforeEach(() => {
      presence = { onlineUserIds: jest.fn().mockReturnValue([]) };
      users = { findStatusesByIds: jest.fn().mockResolvedValue([]) };
      eventEmitter = { emit: jest.fn() };
      service = new ChatSessionEnforcementService(
        presence as unknown as PresenceService,
        users as unknown as UsersService,
        eventEmitter as unknown as EventEmitter2,
      );
    });

    it('handles an empty online set without a query', async () => {
      presence.onlineUserIds.mockReturnValue([]);

      await service.revalidateLiveSessions();

      expect(users.findStatusesByIds).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('batches every online id into ONE findStatusesByIds call', async () => {
      presence.onlineUserIds.mockReturnValue(['u1', 'u2', 'u3']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'u1', status: UserStatus.Active },
        { id: 'u2', status: UserStatus.Active },
        { id: 'u3', status: UserStatus.Active },
      ]);

      await service.revalidateLiveSessions();

      expect(users.findStatusesByIds).toHaveBeenCalledTimes(1);
      expect(users.findStatusesByIds).toHaveBeenCalledWith(['u1', 'u2', 'u3']);
    });

    it('leaves an Active member alone', async () => {
      presence.onlineUserIds.mockReturnValue(['u1']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'u1', status: UserStatus.Active },
      ]);

      await service.revalidateLiveSessions();

      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('revokes a Suspended member', async () => {
      presence.onlineUserIds.mockReturnValue(['u1']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'u1', status: UserStatus.Suspended },
      ]);

      await service.revalidateLiveSessions();

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(USER_SESSION_REVOKED, {
        userId: 'u1',
      });
    });

    it('revokes a Deactivated member', async () => {
      presence.onlineUserIds.mockReturnValue(['u1']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'u1', status: UserStatus.Deactivated },
      ]);

      await service.revalidateLiveSessions();

      expect(eventEmitter.emit).toHaveBeenCalledWith(USER_SESSION_REVOKED, {
        userId: 'u1',
      });
    });

    it('revokes a member MISSING from the result (row deleted, or otherwise gone), the same as an explicit non-active status', async () => {
      presence.onlineUserIds.mockReturnValue(['u1', 'ghost']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'u1', status: UserStatus.Active },
      ]);

      await service.revalidateLiveSessions();

      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(USER_SESSION_REVOKED, {
        userId: 'ghost',
      });
    });

    it('revokes every non-active member independently in a mixed batch, and leaves the active one alone', async () => {
      presence.onlineUserIds.mockReturnValue(['active', 'suspended', 'gone']);
      users.findStatusesByIds.mockResolvedValue([
        { id: 'active', status: UserStatus.Active },
        { id: 'suspended', status: UserStatus.Suspended },
      ]);

      await service.revalidateLiveSessions();

      expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
      expect(eventEmitter.emit).toHaveBeenCalledWith(USER_SESSION_REVOKED, {
        userId: 'suspended',
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith(USER_SESSION_REVOKED, {
        userId: 'gone',
      });
    });

    it('does not throw when the users call fails, and logs instead so the next tick can retry', async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      presence.onlineUserIds.mockReturnValue(['u1']);
      users.findStatusesByIds.mockRejectedValue(
        new Error('connection terminated'),
      );

      await expect(service.revalidateLiveSessions()).resolves.toBeUndefined();

      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Live-session revalidation failed'),
      );
      errorSpy.mockRestore();
    });
  });

  // These exercise the ACTUAL @Interval('chat-session-revalidation', 60_000)
  // registration through a real Nest module (ScheduleModule.forRoot()), rather
  // than calling revalidateLiveSessions() directly: the 60s cadence and the
  // module-destroy cleanup are entirely owned by @nestjs/schedule's
  // SchedulerOrchestrator (mountIntervals on bootstrap, clearIntervals on
  // beforeApplicationShutdown), keyed off the interval name the @Interval
  // decorator declares, so the only faithful way to assert either is to boot
  // and close the real module and watch SchedulerRegistry.
  describe('@Interval registration and module lifecycle', () => {
    afterEach(() => {
      jest.useRealTimers();
    });

    async function buildModule(
      presence: { onlineUserIds: jest.Mock },
      users: { findStatusesByIds: jest.Mock },
    ): Promise<TestingModule> {
      const moduleRef = await Test.createTestingModule({
        imports: [ScheduleModule.forRoot(), EventEmitterModule.forRoot()],
        providers: [
          ChatSessionEnforcementService,
          { provide: PresenceService, useValue: presence },
          { provide: UsersService, useValue: users },
        ],
      }).compile();
      await moduleRef.init();
      return moduleRef;
    }

    it('registers the sweep under the documented name at the documented 60s cadence', async () => {
      jest.useFakeTimers();
      const presence = { onlineUserIds: jest.fn().mockReturnValue([]) };
      const users = { findStatusesByIds: jest.fn().mockResolvedValue([]) };
      const moduleRef = await buildModule(presence, users);

      expect(SESSION_SWEEP_INTERVAL_MS).toBe(60_000);
      const registry = moduleRef.get(SchedulerRegistry);
      expect(registry.getInterval('chat-session-revalidation')).toBeDefined();

      await moduleRef.close();
    });

    it('runs the sweep on its own every 60 seconds, with no manual call', async () => {
      jest.useFakeTimers();
      const presence = { onlineUserIds: jest.fn().mockReturnValue(['u1']) };
      const users = {
        findStatusesByIds: jest
          .fn()
          .mockResolvedValue([{ id: 'u1', status: UserStatus.Active }]),
      };
      const moduleRef = await buildModule(presence, users);

      expect(users.findStatusesByIds).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
      expect(users.findStatusesByIds).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
      expect(users.findStatusesByIds).toHaveBeenCalledTimes(2);

      await moduleRef.close();
    });

    it('clears the interval on module destroy, so no further ticks fire', async () => {
      jest.useFakeTimers();
      const presence = { onlineUserIds: jest.fn().mockReturnValue(['u1']) };
      const users = {
        findStatusesByIds: jest
          .fn()
          .mockResolvedValue([{ id: 'u1', status: UserStatus.Active }]),
      };
      const moduleRef = await buildModule(presence, users);
      const registry = moduleRef.get(SchedulerRegistry);
      expect(registry.getInterval('chat-session-revalidation')).toBeDefined();

      await moduleRef.close();

      expect(() => {
        registry.getInterval('chat-session-revalidation');
      }).toThrow();

      users.findStatusesByIds.mockClear();
      await jest.advanceTimersByTimeAsync(SESSION_SWEEP_INTERVAL_MS);
      expect(users.findStatusesByIds).not.toHaveBeenCalled();
    });
  });
});
