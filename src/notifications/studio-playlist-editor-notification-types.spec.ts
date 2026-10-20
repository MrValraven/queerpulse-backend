import { Notification, NotificationType } from './entities/notification.entity';
import { bundleKeyFor } from './notification-bundling';
import {
  ALWAYS_DELIVERED_NOTIFICATION_TYPES,
  NotificationPreferenceCategory,
  categoryForType,
} from './notification-preferences';
import { ACTOR_PAYLOAD_KEY, toClientPayload } from './notification-response';

const INVITE_PAYLOAD = {
  playlistId: 'playlist-1',
  playlistName: 'Night bus',
  actorId: 'owner-1',
};

const ADDED_PAYLOAD = { ...INVITE_PAYLOAD, personaName: 'Night Shift' };

const INVITATION_TYPES = [
  NotificationType.StudioPlaylistEditorInvite,
  NotificationType.StudioPlaylistEditorInviteAccepted,
  NotificationType.StudioPlaylistEditorInviteDeclined,
];

function notificationRow(
  type: NotificationType,
  payload: Record<string, unknown>,
): Notification {
  return {
    id: 'notification-1',
    userId: 'recipient-1',
    type,
    payload,
    read: false,
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    bundleKey: null,
    otherActorCount: 0,
  };
}

describe('Studio playlist editor notification types', () => {
  it('stores the labels the migration adds', () => {
    expect(NotificationType.StudioPlaylistEditorInvite).toBe(
      'studio_playlist_editor_invite',
    );
    expect(NotificationType.StudioPlaylistEditorInviteAccepted).toBe(
      'studio_playlist_editor_invite_accepted',
    );
    expect(NotificationType.StudioPlaylistEditorInviteDeclined).toBe(
      'studio_playlist_editor_invite_declined',
    );
    expect(NotificationType.StudioPlaylistEditorAdded).toBe(
      'studio_playlist_editor_added',
    );
  });

  it.each(INVITATION_TYPES)('puts %s behind the Invitations switch', (type) => {
    expect(categoryForType(type)).toBe(
      NotificationPreferenceCategory.Invitations,
    );
    expect(ALWAYS_DELIVERED_NOTIFICATION_TYPES).not.toContain(type);
  });

  it('puts a pick as persona playlist editor behind the Personas switch', () => {
    expect(categoryForType(NotificationType.StudioPlaylistEditorAdded)).toBe(
      NotificationPreferenceCategory.Personas,
    );
  });

  it.each([...INVITATION_TYPES, NotificationType.StudioPlaylistEditorAdded])(
    'leaves %s unbundled and names the counterpart member as the actor',
    (type) => {
      expect(bundleKeyFor(type, ADDED_PAYLOAD)).toBeNull();
      expect(ACTOR_PAYLOAD_KEY[type]).toBe('actorId');
    },
  );

  it.each(INVITATION_TYPES)(
    'forwards the playlist id and name of %s and drops the actor id',
    (type) => {
      expect(toClientPayload(notificationRow(type, INVITE_PAYLOAD))).toEqual({
        playlistId: 'playlist-1',
        playlistName: 'Night bus',
      });
    },
  );

  it('forwards the persona name on a pick and drops the actor id', () => {
    expect(
      toClientPayload(
        notificationRow(NotificationType.StudioPlaylistEditorAdded, {
          ...ADDED_PAYLOAD,
          creditSubprofileId: 'persona-1',
        }),
      ),
    ).toEqual({
      playlistId: 'playlist-1',
      playlistName: 'Night bus',
      personaName: 'Night Shift',
    });
  });
});
