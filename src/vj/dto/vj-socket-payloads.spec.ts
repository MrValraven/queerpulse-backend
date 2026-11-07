import { ValidationPipe } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { VALIDATION_PIPE_OPTIONS } from '../../common/validation-pipe.options';
import {
  createVjStageState,
  VJ_CLIENT_FRAME_NAMES,
  VJ_REMOTE_COMMAND_NAMES,
  type VjClientFrameName,
} from '../vj.contract';
import {
  VjAttachPayloadDto,
  VjClockSyncPayloadDto,
  VjGoClipPayloadDto,
  VjGoGeneratorPayloadDto,
  VjReauthPayloadDto,
  VjRecallScenePayloadDto,
  VjResetLookPayloadDto,
  VjScreenAdvancePayloadDto,
  VjScreenIdentifyPayloadDto,
  VjScreenStatusPayloadDto,
  VjSetCountdownPayloadDto,
  VjSetEffectsPayloadDto,
  VjSetEventCardPayloadDto,
  VjSetLogoPayloadDto,
  VjSetMixPayloadDto,
  VjSetOverlayPayloadDto,
  VjSetPackPayloadDto,
  VjSetScreenOverridePayloadDto,
  VjSetShufflePayloadDto,
  VjSetStrobePayloadDto,
  VjSetTempoPayloadDto,
  VjSetTransitionPayloadDto,
  VjSetlistSelectPayloadDto,
  VjSetlistStepPayloadDto,
  VjSwapMixPayloadDto,
} from './vj-socket-payloads';

const CLIENT_ID = 'c1d2e3f4-0000-4000-8000-000000000001';
const SCREEN_ID = 'c1d2e3f4-0000-4000-8000-000000000002';
const PACK_ID = 'c1d2e3f4-0000-4000-8000-000000000003';
const CLIP_ID = 'c1d2e3f4-0000-4000-8000-000000000004';
const OTHER_CLIP_ID = 'c1d2e3f4-0000-4000-8000-000000000005';
const SCENE_ID = 'c1d2e3f4-0000-4000-8000-000000000006';
const SETLIST_ID = 'c1d2e3f4-0000-4000-8000-000000000007';

/** The stamp every remote command carries (contract 7.5). */
const STAMP = { clientId: CLIENT_ID, commandSequence: 7 };

type PayloadClass = new () => object;

/** One full contract 7.5 payload per client frame. `Record` over the frame
 *  names makes the compiler demand a class for every frame. */
const FRAME_PAYLOADS: Record<
  VjClientFrameName,
  [PayloadClass, Record<string, unknown>]
> = {
  'vj:attach': [
    VjAttachPayloadDto,
    {
      role: 'screen',
      contractVersion: 2,
      screenId: SCREEN_ID,
      restoreState: createVjStageState('epoch-1', 1000),
    },
  ],
  'clock:sync': [VjClockSyncPayloadDto, {}],
  'session:reauth': [VjReauthPayloadDto, { ticket: 'ticket-1' }],
  'stage:setPack': [VjSetPackPayloadDto, { ...STAMP, packId: PACK_ID }],
  'stage:goClip': [VjGoClipPayloadDto, { ...STAMP, clipId: CLIP_ID }],
  'stage:goGenerator': [
    VjGoGeneratorPayloadDto,
    { ...STAMP, generatorId: 'plasma', variant: null },
  ],
  'stage:setTransition': [
    VjSetTransitionPayloadDto,
    { ...STAMP, mode: 'dipBlack', length: { unit: 'beats', value: 4 } },
  ],
  'stage:setOverlay': [
    VjSetOverlayPayloadDto,
    {
      ...STAMP,
      text: 'Hello',
      style: 'neon',
      isVisible: true,
      position: 'bottom',
      size: 'xl',
      colorToken: 'coral',
      hideAfterMs: 30_000,
    },
  ],
  'stage:setEffects': [
    VjSetEffectsPayloadDto,
    {
      ...STAMP,
      speed: 2,
      isBlackout: false,
      settings: {
        monochrome: { isOn: true, amount: 0.5 },
        invert: null,
      },
      isImmediate: false,
    },
  ],
  'stage:setStrobe': [
    VjSetStrobePayloadDto,
    { ...STAMP, isStrobing: false, isImmediate: true },
  ],
  'stage:setShuffle': [
    VjSetShufflePayloadDto,
    {
      ...STAMP,
      isOn: true,
      intervalKind: 'beats',
      intervalValue: 8,
      source: 'favorites',
      excludedClipIds: [CLIP_ID, OTHER_CLIP_ID],
    },
  ],
  'stage:setTempo': [
    VjSetTempoPayloadDto,
    {
      ...STAMP,
      bpm: 124,
      downbeatAt: 1_700_000_000_000,
      quantize: 'bar',
      source: 'tap',
    },
  ],
  'stage:setMix': [
    VjSetMixPayloadDto,
    { ...STAMP, clipId: OTHER_CLIP_ID, amount: 0.4, blendMode: 'screen' },
  ],
  'stage:swapMix': [VjSwapMixPayloadDto, { ...STAMP }],
  'stage:setScreenOverride': [
    VjSetScreenOverridePayloadDto,
    {
      ...STAMP,
      screenId: SCREEN_ID,
      override: {
        clipId: null,
        generatorId: 'tunnel',
        generatorVariant: null,
      },
    },
  ],
  'stage:resetLook': [VjResetLookPayloadDto, { ...STAMP, isImmediate: true }],
  'stage:recallScene': [
    VjRecallScenePayloadDto,
    { ...STAMP, sceneId: SCENE_ID },
  ],
  'stage:setlistSelect': [
    VjSetlistSelectPayloadDto,
    { ...STAMP, setlistId: SETLIST_ID, index: 2 },
  ],
  'stage:setlistNext': [VjSetlistStepPayloadDto, { ...STAMP }],
  'stage:setlistPrevious': [VjSetlistStepPayloadDto, { ...STAMP }],
  'stage:setCountdown': [
    VjSetCountdownPayloadDto,
    { ...STAMP, isVisible: true, durationMs: 60_000, label: 'Doors' },
  ],
  'stage:setLogo': [
    VjSetLogoPayloadDto,
    { ...STAMP, isVisible: true, corner: 'bottomRight' },
  ],
  'stage:setEventCard': [
    VjSetEventCardPayloadDto,
    { ...STAMP, isVisible: true, kind: 'qr' },
  ],
  'screen:identify': [VjScreenIdentifyPayloadDto, { screenId: SCREEN_ID }],
  'screen:advance': [
    VjScreenAdvancePayloadDto,
    { expectedClipSequence: 3, clipId: CLIP_ID },
  ],
  'screen:status': [
    VjScreenStatusPayloadDto,
    {
      isFullscreen: true,
      preload: {
        packId: PACK_ID,
        clips: [
          { clipId: CLIP_ID, state: 'ready', progress: 1, failure: null },
        ],
      },
      health: {
        renderer: 'webgl2',
        fps: 59.8,
        droppedFrames: 2,
        cacheBytes: 52_428_800,
        isEffectLoadHigh: false,
      },
      nextClipId: OTHER_CLIP_ID,
      mic: {
        level: 0.42,
        bpm: 124,
        confidence: 0.8,
        beatAt: 1_700_000_000_500,
      },
    },
  ],
};

/** The pipe the gateway declares: the shared options with the socket's
 *  error shape. */
const gatewayPipe = new ValidationPipe({
  ...VALIDATION_PIPE_OPTIONS,
  validationError: { target: false, value: false },
  exceptionFactory: (errors) => new WsException(errors),
});

/** Runs a plain payload through the gateway pipe as a message body. */
function piped(
  dtoClass: PayloadClass,
  plain: Record<string, unknown>,
): Promise<object> {
  return gatewayPipe.transform(plain, {
    type: 'body',
    metatype: dtoClass,
  }) as Promise<object>;
}

describe('VJ socket payload DTOs', () => {
  it('declares a payload class for every client frame of the contract', () => {
    expect(Object.keys(FRAME_PAYLOADS).sort()).toEqual(
      [...VJ_CLIENT_FRAME_NAMES].sort(),
    );
  });

  it.each(Object.entries(FRAME_PAYLOADS))(
    'lets the full contract payload of %s through unchanged',
    async (_frameName, [dtoClass, plain]) => {
      const instance = await piped(dtoClass, plain);
      expect(instance).toBeInstanceOf(dtoClass);
      expect({ ...instance }).toEqual(plain);
    },
  );

  it('lets the remote attach payload through with its contract version', async () => {
    const plain = { role: 'remote', contractVersion: 1 };
    const instance = await piped(VjAttachPayloadDto, plain);
    expect({ ...instance }).toEqual(plain);
  });

  it('keeps the attach role check', async () => {
    await expect(
      piped(VjAttachPayloadDto, { role: 'mixer', contractVersion: 2 }),
    ).rejects.toBeInstanceOf(WsException);
  });

  it('refuses a v1 shuffle bpm and v1 effect flags', async () => {
    await expect(
      piped(VjSetShufflePayloadDto, { ...STAMP, bpm: 120 }),
    ).rejects.toBeInstanceOf(WsException);
    for (const flag of ['isMonochrome', 'isMirrored', 'isHueCycling']) {
      await expect(
        piped(VjSetEffectsPayloadDto, { ...STAMP, [flag]: true }),
      ).rejects.toBeInstanceOf(WsException);
    }
    await expect(
      piped(VjSetTransitionPayloadDto, { ...STAMP, fadeMs: 800 }),
    ).rejects.toBeInstanceOf(WsException);
  });

  it('lets any isImmediate value through on every stamped command', async () => {
    // The rule kit decides: true on the three commands of contract 7.4,
    // vj_immediate_not_allowed elsewhere, vj_effect_flag_invalid for a
    // non-boolean. The pipe never answers for it.
    for (const commandName of VJ_REMOTE_COMMAND_NAMES) {
      const [dtoClass] = FRAME_PAYLOADS[commandName];
      for (const isImmediate of [true, false, 'yes']) {
        const plain = { ...STAMP, isImmediate };
        const instance = await piped(dtoClass, plain);
        expect({ ...instance }).toEqual(plain);
      }
    }
  });

  it('lets wrong value types through so the stage rules answer their codes', async () => {
    const plain = {
      ...STAMP,
      bpm: '124',
      downbeatAt: null,
      quantize: 5,
      source: [],
    };
    const instance = await piped(VjSetTempoPayloadDto, plain);
    expect({ ...instance }).toEqual(plain);
  });

  it('lets screenId null through on screen:identify', async () => {
    const instance = await piped(VjScreenIdentifyPayloadDto, {
      screenId: null,
    });
    expect({ ...instance }).toEqual({ screenId: null });
  });

  it('keeps screen:identify unstamped', async () => {
    await expect(
      piped(VjScreenIdentifyPayloadDto, { ...STAMP, screenId: null }),
    ).rejects.toBeInstanceOf(WsException);
  });

  it('accepts an empty clock:sync payload and refuses any field on it', async () => {
    const instance = await piped(VjClockSyncPayloadDto, {});
    expect(instance).toBeInstanceOf(VjClockSyncPayloadDto);
    expect({ ...instance }).toEqual({});
    await expect(
      piped(VjClockSyncPayloadDto, { clientNow: 5 }),
    ).rejects.toBeInstanceOf(WsException);
    await expect(
      piped(VjClockSyncPayloadDto, { absentGuard: null }),
    ).rejects.toBeInstanceOf(WsException);
  });
});
