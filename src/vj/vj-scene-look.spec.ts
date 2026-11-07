import {
  checkVjSceneLook,
  normalizeStoredVjSceneLook,
  withoutVjSceneClip,
} from './vj-scene-look';

const CLIP_ID = '11111111-1111-4111-8111-111111111111';
const MIX_CLIP_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CLIP_ID = '33333333-3333-4333-8333-333333333333';

/** A valid look as a remote would send it. */
function validLook(): Record<string, unknown> {
  return {
    source: { kind: 'clip', clipId: CLIP_ID },
    effects: {
      speed: 1,
      settings: { glitch: { isOn: true, amount: 0.4, variant: null } },
    },
    transition: { mode: 'fade', length: { unit: 'ms', value: 800 } },
    overlay: {
      text: 'Hello',
      style: 'big',
      isVisible: true,
      position: 'center',
      size: 'l',
      colorToken: 'cream',
    },
    mix: { clipId: MIX_CLIP_ID, amount: 0.5, blendMode: 'screen' },
  };
}

/** The lookField a look fails at, or null when it passes. */
function lookFieldOf(look: unknown): string | null {
  const result = checkVjSceneLook(look);
  return result.isValid ? null : result.lookField;
}

describe('vj-scene-look', () => {
  it('checks a look in the contract order and names the first bad field', () => {
    expect(lookFieldOf(validLook())).toBeNull();
    expect(lookFieldOf({ ...validLook(), extra: true })).toBe('');
    expect(lookFieldOf('look')).toBe('');
    const oversizedLook = {
      ...validLook(),
      effects: { speed: 1, settings: {}, padding: 'a'.repeat(17_000) },
    };
    expect(lookFieldOf(oversizedLook)).toBe('');
    expect(
      lookFieldOf({ ...validLook(), source: { kind: 'clip', clipId: 'x' } }),
    ).toBe('source.clipId');
    expect(
      lookFieldOf({
        ...validLook(),
        effects: {
          speed: 1,
          settings: { glitch: { isOn: true, amount: 2, variant: null } },
        },
      }),
    ).toBe('effects.settings.glitch.amount');
    expect(
      lookFieldOf({
        ...validLook(),
        overlay: { ...(validLook().overlay as object), text: '   ' },
      }),
    ).toBe('overlay.isVisible');
    expect(
      lookFieldOf({
        ...validLook(),
        mix: { clipId: null, amount: -1, blendMode: 'normal' },
      }),
    ).toBe('mix.amount');
  });

  it('names the first bad field when two parts are bad', () => {
    expect(
      lookFieldOf({
        ...validLook(),
        effects: { speed: 3, settings: {} },
        mix: { clipId: null, amount: -1, blendMode: 'normal' },
      }),
    ).toBe('effects.speed');
  });

  it('checks a generator source and its variant', () => {
    expect(
      lookFieldOf({
        ...validLook(),
        source: {
          kind: 'generator',
          generatorId: 'prideFlagWave',
          generatorVariant: 'trans',
        },
      }),
    ).toBeNull();
    expect(
      lookFieldOf({
        ...validLook(),
        source: {
          kind: 'generator',
          generatorId: 'plasma',
          generatorVariant: 'trans',
        },
      }),
    ).toBe('source.generatorVariant');
    expect(
      lookFieldOf({
        ...validLook(),
        source: { kind: 'generator', generatorId: 'plasma' },
      }),
    ).toBe('source');
  });

  it('refuses incomplete entries, a missing part field and two playhead effects', () => {
    expect(
      lookFieldOf({
        ...validLook(),
        effects: { speed: 1, settings: { glitch: { isOn: true } } },
      }),
    ).toBe('effects.settings.glitch.amount');
    expect(
      lookFieldOf({
        ...validLook(),
        effects: {
          speed: 1,
          settings: {
            freeze: { isOn: true, amount: 1, variant: null },
            reverse: { isOn: true, amount: 1, variant: null },
          },
        },
      }),
    ).toBe('effects.settings');
    expect(lookFieldOf({ ...validLook(), transition: { mode: 'fade' } })).toBe(
      'transition',
    );
    expect(
      lookFieldOf({
        ...validLook(),
        transition: { mode: 'fade', length: { unit: 'ms', value: 5000 } },
      }),
    ).toBe('transition.length');
  });

  it('stores a look canonical', () => {
    const result = checkVjSceneLook({
      ...validLook(),
      source: { kind: 'clip', clipId: CLIP_ID.toUpperCase() },
      effects: {
        speed: 2,
        settings: {
          vhs: { isOn: true, amount: 0.555, variant: null },
          monochrome: { isOn: true, amount: 1, variant: null },
          glitch: { isOn: false, amount: 0.4, variant: null },
        },
      },
      overlay: { ...(validLook().overlay as object), text: '  Hello  ' },
    });
    expect(result.isValid).toBe(true);
    if (!result.isValid) {
      return;
    }
    expect(result.look.source).toEqual({ kind: 'clip', clipId: CLIP_ID });
    expect(result.look.effects).toEqual({
      speed: 2,
      settings: {
        monochrome: { isOn: true, amount: 1, variant: null },
        vhs: { isOn: true, amount: 0.56, variant: null },
      },
    });
    expect(Object.keys(result.look.effects.settings)).toEqual([
      'monochrome',
      'vhs',
    ]);
    expect(result.look.overlay.text).toBe('Hello');
    expect(result.clipIds).toEqual({
      sourceClipId: CLIP_ID,
      mixClipId: MIX_CLIP_ID,
    });
  });

  it('drops an effect id the catalog no longer has when reading a stored look', () => {
    const stored = normalizeStoredVjSceneLook({
      ...validLook(),
      effects: {
        speed: 1,
        settings: {
          sparkle: { isOn: true, amount: 0.5, variant: null },
          glitch: { isOn: true, amount: 0.4, variant: null },
          vhs: { isOn: true, amount: 7, variant: null },
        },
      },
    });
    expect(stored.effects.settings).toEqual({
      glitch: { isOn: true, amount: 0.4, variant: null },
    });
    expect(stored.source).toEqual({ kind: 'clip', clipId: CLIP_ID });
  });

  it('gives a bad stored part its default and never throws', () => {
    const stored = normalizeStoredVjSceneLook({
      ...validLook(),
      transition: { mode: 'spin', length: { unit: 'ms', value: 800 } },
      mix: 'none',
    });
    expect(stored.transition).toEqual({
      mode: 'fade',
      length: { unit: 'ms', value: 800 },
    });
    expect(stored.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'normal',
    });
    expect(stored.overlay.text).toBe('Hello');
    expect(normalizeStoredVjSceneLook(null).source).toBeNull();
    expect(normalizeStoredVjSceneLook(42).effects).toEqual({
      speed: 1,
      settings: {},
    });
  });

  it('keeps one playhead effect and eight effects on when reading a stored look', () => {
    const stored = normalizeStoredVjSceneLook({
      ...validLook(),
      effects: {
        speed: 1,
        settings: {
          freeze: { isOn: true, amount: 1, variant: null },
          reverse: { isOn: true, amount: 1, variant: null },
        },
      },
    });
    expect(stored.effects.settings).toEqual({
      freeze: { isOn: true, amount: 1, variant: null },
    });
  });

  it('takes a deleted clip out of the source and the mix and keeps the blend mode', () => {
    const checked = checkVjSceneLook({
      ...validLook(),
      mix: { clipId: CLIP_ID, amount: 0.7, blendMode: 'difference' },
    });
    if (!checked.isValid) {
      throw new Error('fixture look should pass');
    }
    const rewritten = withoutVjSceneClip(checked.look, CLIP_ID.toUpperCase());
    expect(rewritten?.source).toBeNull();
    expect(rewritten?.mix).toEqual({
      clipId: null,
      amount: 0,
      blendMode: 'difference',
    });
    expect(rewritten?.overlay).toEqual(checked.look.overlay);
  });

  it('answers null when the look does not name the clip', () => {
    const look = normalizeStoredVjSceneLook(validLook());
    expect(withoutVjSceneClip(look, OTHER_CLIP_ID)).toBeNull();
  });
});
