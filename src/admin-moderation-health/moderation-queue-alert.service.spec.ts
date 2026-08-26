import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In } from 'typeorm';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { User } from '../users/entities/user.entity';
import { ModerationQueueAlertState } from './entities/moderation-queue-alert-state.entity';
import { ModerationQueueAlertService } from './moderation-queue-alert.service';
import { ModerationQueueHealthService } from './moderation-queue-health.service';
import {
  ModerationQueueHealthDTO,
  ModerationQueueMeasurement,
  toModerationQueueHealthDTO,
} from './moderation-queue-health-response';
import {
  MODERATION_QUEUE_KEYS,
  ModerationQueueKey,
  ModerationQueueSeverity,
} from './moderation-queue-thresholds';

const FIXED_NOW = new Date('2026-08-26T12:00:00.000Z');

const STAFF_USER_IDS = ['user-mod-1', 'user-mod-2', 'user-admin-1'];

/**
 * Depth values that land each queue on a chosen severity through its DEPTH
 * band, so a scenario reads as "reports are critical" rather than as a table
 * of magic numbers. The bands themselves are covered by the health service's
 * own spec.
 */
const DEPTH_FOR_SEVERITY: Record<
  ModerationQueueKey,
  Record<ModerationQueueSeverity, number>
> = {
  [ModerationQueueKey.InviteRequests]: { ok: 0, warning: 15, critical: 40 },
  [ModerationQueueKey.Reports]: { ok: 0, warning: 10, critical: 25 },
  [ModerationQueueKey.Appeals]: { ok: 0, warning: 8, critical: 20 },
  [ModerationQueueKey.Verification]: { ok: 0, warning: 20, critical: 50 },
  [ModerationQueueKey.BanRatifications]: { ok: 0, warning: 3, critical: 5 },
};

/** A health picture where every queue is `ok` except those named. */
function healthWith(
  severityByQueue: Partial<Record<ModerationQueueKey, ModerationQueueSeverity>>,
): ModerationQueueHealthDTO {
  const measurements: ModerationQueueMeasurement[] = MODERATION_QUEUE_KEYS.map(
    (queue) => ({
      queue,
      depth: DEPTH_FOR_SEVERITY[queue][severityByQueue[queue] ?? 'ok'],
      overdueCount: 0,
      unassignedCount: 0,
      oldestItemHours: null,
      medianResponseHours: null,
    }),
  );
  return toModerationQueueHealthDTO(measurements, 3, FIXED_NOW);
}

function openAlert(
  queue: ModerationQueueKey,
  severity: 'warning' | 'critical',
): ModerationQueueAlertState {
  return {
    queue,
    severity,
    alertedAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
    updatedAt: new Date(FIXED_NOW.getTime() - 60 * 60 * 1000),
  };
}

/**
 * One `createForRecipients` call, typed. `jest.Mock`'s `calls` is `any[][]`,
 * and destructuring it untyped is what the lint rule about unsafe `any`
 * assignment is there to catch.
 */
type AlertCall = [string[], NotificationType, Record<string, unknown>];

function alertCall(mock: jest.Mock, index = 0): AlertCall {
  return mock.mock.calls[index] as AlertCall;
}

describe('ModerationQueueAlertService', () => {
  let service: ModerationQueueAlertService;
  let alertState: {
    find: jest.Mock;
    upsert: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
  };
  let users: { find: jest.Mock };
  let queueHealth: { getQueueHealth: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    alertState = {
      find: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
    };
    users = {
      find: jest.fn().mockResolvedValue(STAFF_USER_IDS.map((id) => ({ id }))),
    };
    queueHealth = {
      getQueueHealth: jest.fn().mockResolvedValue(healthWith({})),
    };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue(STAFF_USER_IDS),
    };
    const moduleRef: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationQueueAlertService,
        {
          provide: getRepositoryToken(ModerationQueueAlertState),
          useValue: alertState,
        },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: ModerationQueueHealthService, useValue: queueHealth },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();

    service = moduleRef.get(ModerationQueueAlertService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('when every queue is healthy', () => {
    it('alerts nobody and writes no state', async () => {
      await service.checkQueues();

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(alertState.upsert).not.toHaveBeenCalled();
      expect(alertState.delete).not.toHaveBeenCalled();
    });

    it('does not even resolve the staff roster', async () => {
      await service.checkQueues();

      expect(users.find).not.toHaveBeenCalled();
    });
  });

  describe('when a queue crosses its warning level', () => {
    beforeEach(() => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'warning' }),
      );
    });

    it('alerts every active moderator and admin, and nobody else', async () => {
      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
      const [recipients, type, payload] = alertCall(
        notifications.createForRecipients,
      );
      expect(recipients).toEqual(STAFF_USER_IDS);
      expect(type).toBe(NotificationType.ModerationQueueAlert);
      expect(payload).toMatchObject({
        source: 'moderation',
        queue: ModerationQueueKey.Reports,
        severity: 'warning',
        depth: DEPTH_FOR_SEVERITY[ModerationQueueKey.Reports].warning,
      });
    });

    it('never passes an actor, so no block or mute can drop duty mail', async () => {
      await service.checkQueues();

      expect(notifications.createForRecipients.mock.calls[0]).toHaveLength(3);
    });

    it('remembers the alert so the next tick can stay quiet', async () => {
      await service.checkQueues();

      expect(alertState.upsert).toHaveBeenCalledWith(
        {
          queue: ModerationQueueKey.Reports,
          severity: 'warning',
          alertedAt: FIXED_NOW,
        },
        ['queue'],
      );
    });
  });

  describe('when a queue crosses its critical level', () => {
    it('alerts at critical and records it', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.BanRatifications]: 'critical' }),
      );

      await service.checkQueues();

      const [, , payload] = alertCall(notifications.createForRecipients);
      expect(payload).toMatchObject({
        queue: ModerationQueueKey.BanRatifications,
        severity: 'critical',
      });
      expect(alertState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'critical' }),
        ['queue'],
      );
    });

    it('raises one alert per queue when several go bad at once, on one roster lookup', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({
          [ModerationQueueKey.Reports]: 'critical',
          [ModerationQueueKey.Appeals]: 'warning',
        }),
      );

      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
      expect(users.find).toHaveBeenCalledTimes(1);
    });
  });

  describe('deduplication', () => {
    it('says nothing when a queue is still at the severity it was last alerted at', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'critical' }),
      );
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'critical'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(alertState.upsert).not.toHaveBeenCalled();
      expect(alertState.delete).not.toHaveBeenCalled();
    });

    it('does not re-alert when a critical queue eases back to warning, but lowers the row', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'warning' }),
      );
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'critical'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(alertState.update).toHaveBeenCalledWith(
        { queue: ModerationQueueKey.Reports },
        { severity: 'warning' },
      );
    });
  });

  describe('escalation', () => {
    it('alerts again when a warning becomes critical', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'critical' }),
      );
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'warning'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
      const [, , payload] = alertCall(notifications.createForRecipients);
      expect(payload).toMatchObject({ severity: 'critical' });
      expect(alertState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ severity: 'critical' }),
        ['queue'],
      );
    });
  });

  describe('recovery', () => {
    it('sends one closing notice and clears the state', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(healthWith({}));
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'critical'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
      const [, type, payload] = alertCall(notifications.createForRecipients);
      expect(type).toBe(NotificationType.ModerationQueueAlert);
      expect(payload).toMatchObject({
        queue: ModerationQueueKey.Reports,
        severity: 'ok',
      });
      expect(alertState.delete).toHaveBeenCalledWith({
        queue: ModerationQueueKey.Reports,
      });
    });

    it('says nothing about a queue that was never in trouble', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(healthWith({}));
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Appeals, 'warning'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
      const [, , payload] = alertCall(notifications.createForRecipients);
      expect(payload).toMatchObject({ queue: ModerationQueueKey.Appeals });
    });
  });

  describe('a queue that recovers and breaches again', () => {
    /**
     * The regression this pins. An earlier revision ran the recipient list
     * through `NotificationPushThrottleService` with a six-hour window, so a
     * queue that recovered and breached again inside that window had its alert
     * silently dropped while the state row was written anyway. Every later
     * tick then read `decide(warning, warning)` as `silent`, and the queue
     * stayed in breach with the moderators' last word on it being "recovered".
     *
     * The throttle is gone and the state row is the whole dedup, so the second
     * breach must alert exactly like the first however soon it arrives.
     */
    it('alerts again on the second breach, however soon it follows the recovery', async () => {
      const breaching = healthWith({
        [ModerationQueueKey.Reports]: 'warning',
      });

      // 01:00: first breach, from a clean slate.
      queueHealth.getQueueHealth.mockResolvedValue(breaching);
      await service.checkQueues();
      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);

      // 02:00: recovery. The row is deleted, so the next tick reads none.
      queueHealth.getQueueHealth.mockResolvedValue(healthWith({}));
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'warning'),
      ]);
      await service.checkQueues();
      expect(notifications.createForRecipients).toHaveBeenCalledTimes(2);
      expect(alertState.delete).toHaveBeenCalledWith({
        queue: ModerationQueueKey.Reports,
      });

      // 03:00: it breaches again, one hour later.
      queueHealth.getQueueHealth.mockResolvedValue(breaching);
      alertState.find.mockResolvedValue([]);
      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(3);
      const [, , payload] = alertCall(notifications.createForRecipients, 2);
      expect(payload).toMatchObject({
        queue: ModerationQueueKey.Reports,
        severity: 'warning',
      });
    });

    it('re-escalates after easing back, rather than going quiet', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'critical' }),
      );
      // The row was lowered to warning on a previous tick when the queue eased.
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'warning'),
      ]);

      await service.checkQueues();

      expect(notifications.createForRecipients).toHaveBeenCalledTimes(1);
      const [, , payload] = alertCall(notifications.createForRecipients);
      expect(payload).toMatchObject({ severity: 'critical' });
    });

    it('never records an alert it did not write', async () => {
      // No active moderators at all: there is nobody to tell, so nothing may
      // be recorded as told. The next tick, once somebody holds the role
      // again, has to alert.
      queueHealth.getQueueHealth.mockResolvedValue(
        healthWith({ [ModerationQueueKey.Reports]: 'critical' }),
      );
      users.find.mockResolvedValue([]);

      await service.checkQueues();

      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(alertState.upsert).not.toHaveBeenCalled();
    });
  });

  describe('retired queues', () => {
    it('reaps an alert-state row whose queue no longer exists', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(healthWith({}));
      alertState.find.mockResolvedValue([
        {
          queue: 'retired_queue' as ModerationQueueKey,
          severity: 'critical' as const,
          alertedAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        },
      ]);

      await service.checkQueues();

      // Never visited by the per-queue loop, so it would otherwise sit there
      // forever contradicting "one row per queue currently in trouble".
      expect(notifications.createForRecipients).not.toHaveBeenCalled();
      expect(alertState.delete).toHaveBeenCalledWith({
        queue: In(['retired_queue']),
      });
    });

    it('issues no reap query when every row maps to a live queue', async () => {
      queueHealth.getQueueHealth.mockResolvedValue(healthWith({}));
      alertState.find.mockResolvedValue([
        openAlert(ModerationQueueKey.Reports, 'warning'),
      ]);

      await service.checkQueues();

      // Exactly one delete, the recovery for `reports`, and no reap on top.
      expect(alertState.delete).toHaveBeenCalledTimes(1);
      expect(alertState.delete).toHaveBeenCalledWith({
        queue: ModerationQueueKey.Reports,
      });
    });
  });

  describe('the cron wrapper', () => {
    it('swallows a failure rather than letting it escape the scheduler', async () => {
      queueHealth.getQueueHealth.mockRejectedValue(new Error('database down'));

      await expect(service.sweepQueueHealth()).resolves.toBeUndefined();
    });
  });
});
