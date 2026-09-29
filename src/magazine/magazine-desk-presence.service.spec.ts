import {
  DESK_PRESENCE_GRACE_WINDOW_MS,
  DeskViewer,
  MagazineDeskPresenceService,
} from './magazine-desk-presence.service';

const marta: DeskViewer = {
  userId: 'marta',
  name: 'Marta Cruz',
  initials: 'MC',
};
const sara: DeskViewer = {
  userId: 'sara',
  name: 'Sara Pinheiro',
  initials: 'SP',
};

describe('MagazineDeskPresenceService', () => {
  let presence: MagazineDeskPresenceService;

  beforeEach(() => {
    presence = new MagazineDeskPresenceService();
  });

  afterEach(() => {
    presence.onModuleDestroy();
    jest.useRealTimers();
  });

  it('lists an editor on the piece they watch', () => {
    expect(presence.watch('piece-1', marta, 'socket-1')).toBe(true);
    expect(presence.viewersOf('piece-1')).toEqual([marta]);
  });

  it('lists an editor once across two tabs on the same piece', () => {
    presence.watch('piece-1', marta, 'socket-1');
    expect(presence.watch('piece-1', marta, 'socket-2')).toBe(false);
    expect(presence.viewersOf('piece-1')).toEqual([marta]);
  });

  it('keeps arrival order across editors', () => {
    presence.watch('piece-1', sara, 'socket-2');
    presence.watch('piece-1', marta, 'socket-1');
    expect(presence.viewersOf('piece-1')).toEqual([sara, marta]);
  });

  it('removes an editor at once on an explicit unwatch of their last tab', () => {
    presence.watch('piece-1', marta, 'socket-1');
    presence.watch('piece-1', marta, 'socket-2');
    expect(presence.unwatch('piece-1', 'marta', 'socket-1')).toBe(false);
    expect(presence.viewersOf('piece-1')).toEqual([marta]);
    expect(presence.unwatch('piece-1', 'marta', 'socket-2')).toBe(true);
    expect(presence.viewersOf('piece-1')).toEqual([]);
  });

  it('ignores an unwatch from a socket that never watched the piece', () => {
    presence.watch('piece-1', marta, 'socket-1');
    expect(presence.unwatch('piece-1', 'marta', 'socket-9')).toBe(false);
    expect(presence.viewersOf('piece-1')).toEqual([marta]);
  });

  it('counts the pieces one socket watches', () => {
    presence.watch('piece-1', marta, 'socket-1');
    presence.watch('piece-2', marta, 'socket-1');
    expect(presence.watchedPieceCount('socket-1')).toBe(2);
    presence.unwatch('piece-1', 'marta', 'socket-1');
    expect(presence.watchedPieceCount('socket-1')).toBe(1);
  });

  it('knows which pieces a socket already watches', () => {
    presence.watch('piece-1', marta, 'socket-1');
    expect(presence.isWatching('socket-1', 'piece-1')).toBe(true);
    expect(presence.isWatching('socket-1', 'piece-2')).toBe(false);
    expect(presence.isWatching('socket-9', 'piece-1')).toBe(false);
    presence.unwatch('piece-1', 'marta', 'socket-1');
    expect(presence.isWatching('socket-1', 'piece-1')).toBe(false);
  });

  it('maps every watched piece for the desk broadcast', () => {
    presence.watch('piece-1', marta, 'socket-1');
    presence.watch('piece-2', sara, 'socket-2');
    presence.watch('piece-2', marta, 'socket-1');
    expect(presence.viewersByPiece()).toEqual({
      'piece-1': [marta],
      'piece-2': [sara, marta],
    });
  });

  describe('grace window on disconnect', () => {
    it('keeps the editor listed until the window lapses, then reports it', () => {
      jest.useFakeTimers();
      presence.watch('piece-1', marta, 'socket-1');
      presence.watch('piece-2', marta, 'socket-1');
      const onGraceExpired = jest.fn();

      presence.releaseSocket('marta', 'socket-1', onGraceExpired);

      expect(presence.viewersOf('piece-1')).toEqual([marta]);
      jest.advanceTimersByTime(DESK_PRESENCE_GRACE_WINDOW_MS - 1);
      expect(onGraceExpired).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      expect(onGraceExpired).toHaveBeenCalledWith('piece-1');
      expect(onGraceExpired).toHaveBeenCalledWith('piece-2');
      expect(presence.viewersOf('piece-1')).toEqual([]);
      expect(presence.viewersByPiece()).toEqual({});
    });

    it('a reconnect that re-watches inside the window cancels the removal', () => {
      jest.useFakeTimers();
      presence.watch('piece-1', marta, 'socket-1');
      const onGraceExpired = jest.fn();

      presence.releaseSocket('marta', 'socket-1', onGraceExpired);
      jest.advanceTimersByTime(DESK_PRESENCE_GRACE_WINDOW_MS / 2);
      expect(presence.watch('piece-1', marta, 'socket-2')).toBe(false);
      jest.advanceTimersByTime(DESK_PRESENCE_GRACE_WINDOW_MS);

      expect(onGraceExpired).not.toHaveBeenCalled();
      expect(presence.viewersOf('piece-1')).toEqual([marta]);
    });

    it('schedules nothing while another tab still watches the piece', () => {
      jest.useFakeTimers();
      presence.watch('piece-1', marta, 'socket-1');
      presence.watch('piece-1', marta, 'socket-2');
      const onGraceExpired = jest.fn();

      presence.releaseSocket('marta', 'socket-1', onGraceExpired);
      jest.advanceTimersByTime(DESK_PRESENCE_GRACE_WINDOW_MS);

      expect(onGraceExpired).not.toHaveBeenCalled();
      expect(presence.viewersOf('piece-1')).toEqual([marta]);
      expect(presence.watchedPieceCount('socket-1')).toBe(0);
    });

    it('a duplicate release fires the removal once', () => {
      jest.useFakeTimers();
      presence.watch('piece-1', marta, 'socket-1');
      const onGraceExpired = jest.fn();

      presence.releaseSocket('marta', 'socket-1', onGraceExpired);
      presence.releaseSocket('marta', 'socket-1', onGraceExpired);
      jest.advanceTimersByTime(DESK_PRESENCE_GRACE_WINDOW_MS);

      expect(onGraceExpired).toHaveBeenCalledTimes(1);
    });

    it('releasing an unknown socket is a no-op', () => {
      const onGraceExpired = jest.fn();
      presence.releaseSocket('ghost', 'socket-9', onGraceExpired);
      expect(onGraceExpired).not.toHaveBeenCalled();
      expect(presence.viewersByPiece()).toEqual({});
    });
  });
});
