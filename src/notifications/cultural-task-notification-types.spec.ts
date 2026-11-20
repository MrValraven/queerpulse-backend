import { Notification, NotificationType } from './entities/notification.entity';
import { visibleThroughActorBlocks } from './notification-actor-block';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  categoryForType,
} from './notification-preferences';
import {
  ACTOR_PAYLOAD_KEY,
  actorIdOf,
  toClientPayload,
} from './notification-response';

const TASK_ID = '5b2c7e10-9a43-4d6f-8e21-1c0f3a7b9d52';
const GUIDE_ID = 'c41d8f36-2e75-4b90-a6d3-7f1e0b5c8a29';
const ASSIGNER_ID = '3a9e4b1c-6d27-4f80-8b13-5c2e7d0f1a64';

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'staff-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-11-20T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

/** The notices a staff member gets when somebody else assigns them Cultural Production tasks. */
describe('Cultural Production task notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.CulturalTaskAssigned).toBe(
      'cultural_task_assigned',
    );
    expect(NotificationType.CulturalTaskBatchAssigned).toBe(
      'cultural_task_batch_assigned',
    );
  });

  it('has no member switch for either type', () => {
    expect(categoryForType(NotificationType.CulturalTaskAssigned)).toBeNull();
    expect(
      categoryForType(NotificationType.CulturalTaskBatchAssigned),
    ).toBeNull();
  });

  it('delivers both types always', () => {
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(
      NotificationType.CulturalTaskAssigned,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(
      NotificationType.CulturalTaskBatchAssigned,
    );
  });

  it('names the assigner as the actor for both types', () => {
    expect(ACTOR_PAYLOAD_KEY[NotificationType.CulturalTaskAssigned]).toBe(
      'assignedById',
    );
    expect(ACTOR_PAYLOAD_KEY[NotificationType.CulturalTaskBatchAssigned]).toBe(
      'assignedById',
    );
    expect(
      actorIdOf(
        notificationRow(NotificationType.CulturalTaskAssigned, {
          taskId: TASK_ID,
          taskTitle: 'Print the flyers',
          assignedById: ASSIGNER_ID,
        }),
      ),
    ).toBe(ASSIGNER_ID);
    expect(
      actorIdOf(
        notificationRow(NotificationType.CulturalTaskBatchAssigned, {
          guideId: GUIDE_ID,
          guideTitle: 'Pride week guide',
          taskCount: 4,
          assignedById: ASSIGNER_ID,
        }),
      ),
    ).toBe(ASSIGNER_ID);
  });

  it('forwards the task id and title only', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.CulturalTaskAssigned, {
          taskId: TASK_ID,
          taskTitle: 'Print the flyers',
          assignedById: ASSIGNER_ID,
          description: 'Secret task body',
          comment: 'x',
        }),
      ),
    ).toEqual({ taskId: TASK_ID, taskTitle: 'Print the flyers' });
  });

  it('forwards the guide id, title and task count only', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.CulturalTaskBatchAssigned, {
          guideId: GUIDE_ID,
          guideTitle: 'Pride week guide',
          taskCount: 4,
          assignedById: ASSIGNER_ID,
          notes: 'Secret guide notes',
        }),
      ),
    ).toEqual({
      guideId: GUIDE_ID,
      guideTitle: 'Pride week guide',
      taskCount: 4,
    });
  });

  it('never bundles', () => {
    expect(
      bundleKeyFor(NotificationType.CulturalTaskAssigned, {
        taskId: TASK_ID,
        assignedById: ASSIGNER_ID,
      }),
    ).toBeNull();
    expect(
      bundleKeyFor(NotificationType.CulturalTaskBatchAssigned, {
        guideId: GUIDE_ID,
        assignedById: ASSIGNER_ID,
      }),
    ).toBeNull();
  });

  it('joins the read-time actor block filter on its own key', () => {
    const sql =
      visibleThroughActorBlocks('reader-1').getSql?.('Notification.id') ?? '';
    expect(sql).toMatch(
      /'cultural_task_assigned'[^)]*\) THEN \(Notification\.payload\) ->> 'assignedById'/,
    );
    expect(sql).toMatch(
      /'cultural_task_batch_assigned'[^)]*\) THEN \(Notification\.payload\) ->> 'assignedById'/,
    );
  });
});
