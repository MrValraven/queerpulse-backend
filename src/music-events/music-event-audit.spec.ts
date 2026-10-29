import {
  buildMusicEventAuditRow,
  MUSIC_EVENT_AUDIT_ACTIONS,
} from './music-event-audit';

describe('music event audit rows', () => {
  it('builds a member-targeted row with the slug as note', () => {
    expect(
      buildMusicEventAuditRow({
        actorId: 'actor-1',
        action: MUSIC_EVENT_AUDIT_ACTIONS.guestRemoved,
        eventSlug: 'warehouse-night',
        eventTitle: 'Warehouse Night',
        targetUserId: 'member-1',
        targetName: 'Ana Silva',
      }),
    ).toEqual({
      reportId: null,
      actorId: 'actor-1',
      action: 'music_event_guest_removed',
      targetUserId: 'member-1',
      targetName: 'Ana Silva',
      reasonCode: null,
      note: 'warehouse-night',
      duration: null,
    });
  });

  it('names the event as subject when no member is targeted', () => {
    expect(
      buildMusicEventAuditRow({
        actorId: 'actor-1',
        action: MUSIC_EVENT_AUDIT_ACTIONS.cancelled,
        eventSlug: 'warehouse-night',
        eventTitle: 'Warehouse Night',
      }),
    ).toEqual({
      reportId: null,
      actorId: 'actor-1',
      action: 'music_event_cancelled',
      targetUserId: null,
      targetName: 'Warehouse Night',
      reasonCode: null,
      note: 'warehouse-night',
      duration: null,
    });
  });

  it('joins detail after the slug', () => {
    expect(
      buildMusicEventAuditRow({
        actorId: 'actor-1',
        action: MUSIC_EVENT_AUDIT_ACTIONS.invitesSent,
        eventSlug: 'warehouse-night',
        eventTitle: 'Warehouse Night',
        detail: '12 invites',
      }).note,
    ).toBe('warehouse-night: 12 invites');
  });

  it('lists fifteen distinct actions, all prefixed music_event_', () => {
    const actions = Object.values(MUSIC_EVENT_AUDIT_ACTIONS);
    expect(actions).toHaveLength(15);
    expect(new Set(actions).size).toBe(15);
    expect(actions.every((action) => action.startsWith('music_event_'))).toBe(
      true,
    );
  });
});
