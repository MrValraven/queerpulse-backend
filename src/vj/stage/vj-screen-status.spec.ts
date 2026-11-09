import {
  parseVjScreenStatus,
  toVjScreenStatusList,
  type VjScreenEntry,
} from './vj-screen-status';

const NOW = 1_800_000_000_000;
const PACK_ID = '44444444-4444-4444-8444-444444444444';
const CLIP_ID = '22222222-2222-4222-8222-222222222222';
const NEXT_CLIP_ID = 'ABCDEF01-2345-4678-89AB-CDEF01234567';

function validHealth(): Record<string, unknown> {
  return {
    renderer: 'webgl2',
    fps: 59.94,
    droppedFrames: 3,
    cacheBytes: 52_428_800,
    isEffectLoadHigh: false,
  };
}

function validMic(): Record<string, unknown> {
  return { level: 0.456, bpm: 126.4, confidence: 0.8, beatAt: NOW - 120 };
}

function validPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    isFullscreen: true,
    preload: {
      packId: PACK_ID,
      clips: [{ clipId: CLIP_ID, state: 'ready', progress: 1, failure: null }],
    },
    health: validHealth(),
    nextClipId: NEXT_CLIP_ID,
    mic: validMic(),
    ...overrides,
  };
}

function screenEntry(overrides: Partial<VjScreenEntry> = {}): VjScreenEntry {
  return {
    screenId: 'screen-one',
    number: 1,
    socketId: 'socket-one',
    isFullscreen: false,
    connectedAt: NOW - 5000,
    connectionOrder: 1,
    disconnectedAt: null,
    lastSeenAt: NOW,
    preload: { packId: null, clips: [] },
    health: null,
    nextClipId: null,
    mic: null,
    ...overrides,
  };
}

describe('vj screen status', () => {
  it('keeps a health report from the simple renderer', () => {
    const parsed = parseVjScreenStatus(
      validPayload({ health: { ...validHealth(), renderer: 'simple' } }),
      true,
      NOW,
    );
    expect(parsed?.health?.renderer).toBe('simple');
  });

  it('stores health, next clip and mic when valid and null when not', () => {
    const parsed = parseVjScreenStatus(validPayload(), true, NOW);
    expect(parsed).toEqual({
      isFullscreen: true,
      preload: {
        packId: PACK_ID,
        clips: [
          { clipId: CLIP_ID, state: 'ready', progress: 1, failure: null },
        ],
      },
      health: {
        renderer: 'webgl2',
        fps: 59.9,
        droppedFrames: 3,
        cacheBytes: 52_428_800,
        isEffectLoadHigh: false,
      },
      nextClipId: NEXT_CLIP_ID.toLowerCase(),
      mic: { level: 0.46, bpm: 126.4, confidence: 0.8, beatAt: NOW - 120 },
    });

    const invalidHealths = [
      { ...validHealth(), fps: 241 },
      { ...validHealth(), droppedFrames: 1.5 },
      { ...validHealth(), renderer: 'canvas' },
      { ...validHealth(), cacheBytes: -1 },
      { ...validHealth(), isEffectLoadHigh: 'yes' },
    ];
    for (const health of invalidHealths) {
      const result = parseVjScreenStatus(validPayload({ health }), true, NOW);
      expect(result?.health).toBeNull();
      expect(result?.mic).not.toBeNull();
      expect(result?.nextClipId).toBe(NEXT_CLIP_ID.toLowerCase());
    }

    const invalidMics = [
      { ...validMic(), beatAt: NOW + 5001 },
      { ...validMic(), beatAt: NOW - 5001 },
      { ...validMic(), level: 1.2 },
      { ...validMic(), bpm: 59 },
      { ...validMic(), confidence: -0.1 },
      { ...validMic(), beatAt: NOW + 0.5 },
    ];
    for (const mic of invalidMics) {
      const result = parseVjScreenStatus(validPayload({ mic }), true, NOW);
      expect(result?.mic).toBeNull();
      expect(result?.health).not.toBeNull();
    }
    const edgeMic = parseVjScreenStatus(
      validPayload({ mic: { ...validMic(), beatAt: NOW + 5000 } }),
      true,
      NOW,
    );
    expect(edgeMic?.mic?.beatAt).toBe(NOW + 5000);
    const quietMic = parseVjScreenStatus(
      validPayload({ mic: { ...validMic(), bpm: null, beatAt: null } }),
      true,
      NOW,
    );
    expect(quietMic?.mic).toEqual({
      level: 0.46,
      bpm: null,
      confidence: 0.8,
      beatAt: null,
    });

    const badNextClip = parseVjScreenStatus(
      validPayload({ nextClipId: 'not-a-uuid' }),
      true,
      NOW,
    );
    expect(badNextClip?.nextClipId).toBeNull();
    expect(badNextClip?.health).not.toBeNull();

    const bare = parseVjScreenStatus(
      {
        isFullscreen: false,
        preload: { packId: null, clips: [] },
      },
      true,
      NOW,
    );
    expect(bare).toEqual({
      isFullscreen: false,
      preload: { packId: null, clips: [] },
      health: null,
      nextClipId: null,
      mic: null,
    });
  });

  it('stores a follower next clip as null', () => {
    const parsed = parseVjScreenStatus(validPayload(), false, NOW);
    expect(parsed?.nextClipId).toBeNull();
    expect(parsed?.health).not.toBeNull();
    expect(parsed?.mic).not.toBeNull();
  });

  it('drops the whole frame for a malformed pair', () => {
    expect(
      parseVjScreenStatus(validPayload({ isFullscreen: 'yes' }), true, NOW),
    ).toBeNull();
    expect(
      parseVjScreenStatus(validPayload({ preload: null }), true, NOW),
    ).toBeNull();
    expect(
      parseVjScreenStatus(
        validPayload({ preload: { packId: 'nope', clips: [] } }),
        true,
        NOW,
      ),
    ).toBeNull();
    expect(
      parseVjScreenStatus(
        validPayload({
          preload: {
            packId: PACK_ID,
            clips: [{ clipId: CLIP_ID, state: 'ready', progress: 2 }],
          },
        }),
        true,
        NOW,
      ),
    ).toBeNull();
  });

  it('rounds fps to one decimal and the mic level to two', () => {
    const parsed = parseVjScreenStatus(
      validPayload({
        health: { ...validHealth(), fps: 29.97 },
        mic: { ...validMic(), level: 0.123 },
      }),
      true,
      NOW,
    );
    expect(parsed?.health?.fps).toBe(30);
    expect(parsed?.mic?.level).toBe(0.12);
  });

  it('relays the next clip for the current lead only', () => {
    const health = {
      renderer: 'dom' as const,
      fps: 60,
      droppedFrames: 0,
      cacheBytes: 0,
      isEffectLoadHigh: false,
    };
    const leadEntry = screenEntry({
      screenId: 'screen-two',
      number: 2,
      socketId: 'socket-two',
      nextClipId: CLIP_ID,
      health,
      mic: { level: 0.5, bpm: 128, confidence: 0.9, beatAt: NOW },
    });
    const demotedEntry = screenEntry({
      screenId: 'screen-one',
      number: 1,
      socketId: 'socket-one',
      nextClipId: CLIP_ID,
    });
    const offlineEntry = screenEntry({
      screenId: 'screen-three',
      number: 3,
      socketId: null,
      connectedAt: null,
      disconnectedAt: NOW - 1000,
    });

    const list = toVjScreenStatusList(
      [offlineEntry, leadEntry, demotedEntry],
      'socket-two',
    );
    expect(list.map((screen) => screen.number)).toEqual([1, 2, 3]);
    expect(list[0]).toMatchObject({ isLead: false, nextClipId: null });
    expect(list[1]).toMatchObject({
      isLead: true,
      isConnected: true,
      nextClipId: CLIP_ID,
      health,
      mic: { level: 0.5, detectedBpm: 128, confidence: 0.9 },
    });
    expect(list[1]?.mic).not.toHaveProperty('beatAt');
    expect(list[2]).toMatchObject({
      isConnected: false,
      isLead: false,
      nextClipId: null,
      health: null,
      mic: null,
    });
    expect(list[1]?.health).not.toBe(leadEntry.health);

    const noLead = toVjScreenStatusList([leadEntry, demotedEntry], null);
    expect(noLead.every((screen) => screen.nextClipId === null)).toBe(true);
    expect(noLead.every((screen) => !screen.isLead)).toBe(true);
  });

  it('relays null health and mic for an offline screen that reported both', () => {
    const offlineEntry = screenEntry({
      socketId: null,
      connectedAt: null,
      disconnectedAt: NOW - 1000,
      health: {
        renderer: 'webgl2',
        fps: 60,
        droppedFrames: 0,
        cacheBytes: 1024,
        isEffectLoadHigh: false,
      },
      mic: { level: 0.7, bpm: 124, confidence: 0.8, beatAt: NOW - 1500 },
    });

    const [listed] = toVjScreenStatusList([offlineEntry], null);
    expect(listed).toMatchObject({
      isConnected: false,
      health: null,
      mic: null,
    });
  });
});
