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

const LEAD_ID = '7d1f0c52-3b8a-4c1e-9a55-0f6b2f5d9a10';
const ASSIGNER_ID = '3a9e4b1c-6d27-4f80-8b13-5c2e7d0f1a64';

function notificationRow(payload: Record<string, unknown>): Notification {
  return {
    id: 'notification-1',
    userId: 'staff-1',
    type: NotificationType.LeadAssigned,
    payload,
    read: false,
    createdAt: new Date('2026-11-16T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

/** The notice a staff member gets when somebody else puts them in charge of a lead. */
describe('LeadAssigned notification type', () => {
  it('stores the label the migration adds', () => {
    expect(NotificationType.LeadAssigned).toBe('lead_assigned');
  });

  it('is always delivered with no member switch', () => {
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).toContain(
      NotificationType.LeadAssigned,
    );
    expect(categoryForType(NotificationType.LeadAssigned)).toBeNull();
  });

  it('names the assigner as the actor', () => {
    expect(ACTOR_PAYLOAD_KEY[NotificationType.LeadAssigned]).toBe(
      'assignedById',
    );
    expect(
      actorIdOf(
        notificationRow({ leadId: LEAD_ID, assignedById: ASSIGNER_ID }),
      ),
    ).toBe(ASSIGNER_ID);
  });

  it('forwards the lead id only', () => {
    expect(
      toClientPayload(
        notificationRow({
          leadId: LEAD_ID,
          assignedById: ASSIGNER_ID,
          leadName: 'Secret Lead',
          email: 'a@b.pt',
          notes: 'x',
        }),
      ),
    ).toEqual({ leadId: LEAD_ID });
  });

  it('never bundles', () => {
    expect(
      bundleKeyFor(NotificationType.LeadAssigned, {
        leadId: LEAD_ID,
        assignedById: ASSIGNER_ID,
      }),
    ).toBeNull();
  });

  it('joins the read-time actor block filter on its own key', () => {
    expect(
      visibleThroughActorBlocks('reader-1').getSql?.('Notification.id') ?? '',
    ).toMatch(
      /'lead_assigned'[^)]*\) THEN \(Notification\.payload\) ->> 'assignedById'/,
    );
  });
});
