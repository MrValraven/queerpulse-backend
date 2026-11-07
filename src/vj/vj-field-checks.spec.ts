import { VJ_EFFECT_IDS } from './vj.contract';
import {
  canonicalVjEffectSettings,
  checkVjEffectSettingsPatch,
  checkVjGeneratorChoice,
  checkVjMixFields,
  checkVjOverlayFields,
  checkVjOverlayText,
  checkVjTransitionFields,
  isVjSpeed,
  mergeVjEffectSettings,
} from './vj-field-checks';

const CLIP_ID = '11111111-1111-4111-8111-111111111111';

describe('vj-field-checks', () => {
  describe('effect settings', () => {
    it('checks effect settings in catalog order', () => {
      const result = checkVjEffectSettingsPatch(
        { vhs: { amount: 2 }, invert: { variant: 'sometimes' } },
        { isComplete: false },
      );
      expect(result.failure).toEqual({
        code: 'vj_effect_variant_invalid',
        path: 'invert.variant',
      });
    });

    it('answers vj_effect_unknown for a non-object, 35 keys or an unknown id', () => {
      const unknownFailure = { code: 'vj_effect_unknown', path: '' };
      expect(
        checkVjEffectSettingsPatch('glitch', { isComplete: false }).failure,
      ).toEqual(unknownFailure);
      expect(
        checkVjEffectSettingsPatch([], { isComplete: false }).failure,
      ).toEqual(unknownFailure);
      const tooManyKeys: Record<string, unknown> = {};
      for (const effectId of VJ_EFFECT_IDS) {
        tooManyKeys[effectId] = null;
      }
      tooManyKeys.sparkle = null;
      expect(Object.keys(tooManyKeys)).toHaveLength(35);
      expect(
        checkVjEffectSettingsPatch(tooManyKeys, { isComplete: false }).failure,
      ).toEqual(unknownFailure);
      expect(
        checkVjEffectSettingsPatch(
          { sparkle: { isOn: true } },
          { isComplete: false },
        ).failure,
      ).toEqual(unknownFailure);
      expect(
        checkVjEffectSettingsPatch(
          { glitch: { isOn: true, speed: 2 } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_effect_unknown', path: 'glitch' });
    });

    it('answers each field rule with its code and path', () => {
      expect(
        checkVjEffectSettingsPatch(
          { glitch: { isOn: 'yes' } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_effect_flag_invalid', path: 'glitch.isOn' });
      for (const amount of [-0.1, 1.1, Number.NaN, '0.5']) {
        expect(
          checkVjEffectSettingsPatch(
            { glitch: { amount } },
            { isComplete: false },
          ).failure,
        ).toEqual({ code: 'vj_effect_amount_invalid', path: 'glitch.amount' });
      }
    });

    it('refuses an amount off the default on a fixed effect', () => {
      expect(
        checkVjEffectSettingsPatch(
          { mirror: { amount: 0.5 } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_effect_amount_invalid', path: 'mirror.amount' });
      expect(
        checkVjEffectSettingsPatch(
          { mirror: { amount: 1 } },
          { isComplete: false },
        ).value,
      ).toEqual({ mirror: { amount: 1 } });
    });

    it('refuses null variants on effects with variants and any variant on effects without', () => {
      expect(
        checkVjEffectSettingsPatch(
          { tint: { variant: null } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_effect_variant_invalid', path: 'tint.variant' });
      expect(
        checkVjEffectSettingsPatch(
          { glitch: { variant: 'steady' } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_effect_variant_invalid', path: 'glitch.variant' });
      expect(
        checkVjEffectSettingsPatch(
          { tint: { variant: 'jade' }, glitch: { variant: null } },
          { isComplete: false },
        ).value,
      ).toEqual({ tint: { variant: 'jade' }, glitch: { variant: null } });
    });

    it('requires all three fields and refuses null entries when complete', () => {
      expect(
        checkVjEffectSettingsPatch(
          { glitch: { isOn: true, amount: 0.4 } },
          { isComplete: true },
        ).failure,
      ).toEqual({ code: 'vj_effect_variant_invalid', path: 'glitch.variant' });
      expect(
        checkVjEffectSettingsPatch({ glitch: null }, { isComplete: true })
          .failure,
      ).toEqual({ code: 'vj_effect_unknown', path: 'glitch' });
      expect(
        checkVjEffectSettingsPatch({ glitch: null }, { isComplete: false })
          .value,
      ).toEqual({ glitch: null });
    });

    it('rounds amounts to 0.01', () => {
      expect(
        checkVjEffectSettingsPatch(
          { glitch: { amount: 0.456 } },
          { isComplete: false },
        ).value,
      ).toEqual({ glitch: { amount: 0.46 } });
      expect(
        canonicalVjEffectSettings({
          glitch: { isOn: true, amount: 0.123, variant: null },
        }),
      ).toEqual({ glitch: { isOn: true, amount: 0.12, variant: null } });
    });

    it('merges a patch over the current settings and resets a null entry', () => {
      const merged = mergeVjEffectSettings(
        {
          glitch: { isOn: true, amount: 0.7, variant: null },
          tint: { isOn: true, amount: 0.5, variant: 'jade' },
        },
        { glitch: { isOn: false }, tint: null, vhs: { isOn: true } },
      );
      expect(merged.value).toEqual({
        glitch: { isOn: false, amount: 0.7, variant: null },
        vhs: { isOn: true, amount: 0.6, variant: null },
      });
    });

    it('turns the other playhead effects off when one goes on', () => {
      const merged = mergeVjEffectSettings(
        { freeze: { isOn: true, amount: 1, variant: null } },
        { reverse: { isOn: true } },
      );
      expect(merged.value).toEqual({
        reverse: { isOn: true, amount: 1, variant: null },
      });
    });

    it('answers vj_effect_exclusive_conflict for two playhead effects in one patch', () => {
      expect(
        mergeVjEffectSettings(
          {},
          { freeze: { isOn: true }, pingPong: { isOn: true } },
        ).failure,
      ).toEqual({ code: 'vj_effect_exclusive_conflict', path: '' });
    });

    it('answers vj_effects_too_many for a ninth effect', () => {
      const eightOn = Object.fromEntries(
        ['monochrome', 'invert', 'saturate', 'contrast', 'tint'].map(
          (effectId) => [effectId, { isOn: true }],
        ),
      );
      const current = mergeVjEffectSettings(
        {},
        {
          ...eightOn,
          vhs: { isOn: true },
          crt: { isOn: true },
          glitch: { isOn: true },
        },
      );
      expect(current.failure).toBeNull();
      expect(
        mergeVjEffectSettings(current.value ?? {}, { dream: { isOn: true } })
          .failure,
      ).toEqual({ code: 'vj_effects_too_many', path: '' });
    });

    it('drops entries equal to the off default', () => {
      const merged = mergeVjEffectSettings(
        { glitch: { isOn: true, amount: 0.4, variant: null } },
        { glitch: { isOn: false } },
      );
      expect(merged.value).toEqual({});
      expect(
        canonicalVjEffectSettings({
          tint: { isOn: false, amount: 0.5, variant: 'coral' },
          vhs: { isOn: true, amount: 0.6, variant: null },
        }),
      ).toEqual({ vhs: { isOn: true, amount: 0.6, variant: null } });
    });

    it('keeps settings keys in catalog order', () => {
      const canonical = canonicalVjEffectSettings({
        beatPulse: { isOn: true, amount: 0.5, variant: null },
        monochrome: { isOn: true, amount: 1, variant: null },
      });
      expect(Object.keys(canonical)).toEqual(['monochrome', 'beatPulse']);
    });
  });

  it('reads speeds', () => {
    expect(isVjSpeed(0.25)).toBe(true);
    expect(isVjSpeed(0.3)).toBe(false);
    expect(isVjSpeed('1')).toBe(false);
  });

  describe('transition', () => {
    it('checks mode and length with their codes', () => {
      expect(
        checkVjTransitionFields({ mode: 'spin' }, { isComplete: false })
          .failure,
      ).toEqual({ code: 'vj_transition_mode_invalid', path: 'mode' });
      expect(
        checkVjTransitionFields(
          { length: { unit: 'ms', value: 800, extra: true } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_transition_length_invalid', path: 'length' });
      expect(
        checkVjTransitionFields(
          { length: { unit: 'bars', value: 2 } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_transition_length_invalid', path: 'length' });
      expect(
        checkVjTransitionFields(
          { length: { unit: 'ms', value: 4001 } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_fade_out_of_range', path: 'length' });
      expect(
        checkVjTransitionFields(
          { length: { unit: 'beats', value: 3 } },
          { isComplete: false },
        ).failure,
      ).toEqual({ code: 'vj_transition_length_invalid', path: 'length' });
    });

    it('accepts a partial patch and requires both fields when complete', () => {
      expect(
        checkVjTransitionFields(
          { mode: 'iris', clientId: CLIP_ID },
          { isComplete: false },
        ).value,
      ).toEqual({ mode: 'iris' });
      expect(
        checkVjTransitionFields(
          { length: { unit: 'beats', value: 4 } },
          { isComplete: false },
        ).value,
      ).toEqual({ length: { unit: 'beats', value: 4 } });
      expect(
        checkVjTransitionFields({ mode: 'iris' }, { isComplete: true }).failure,
      ).toEqual({ code: 'vj_transition_length_invalid', path: 'length' });
    });
  });

  describe('overlay', () => {
    it('keeps the v1 text rules', () => {
      expect(checkVjOverlayText('  hello  ').value).toBe('hello');
      expect(checkVjOverlayText(5).failure).toEqual({
        code: 'vj_overlay_text_invalid',
        path: 'text',
      });
      expect(checkVjOverlayText('line break').failure?.code).toBe(
        'vj_overlay_text_invalid',
      );
      expect(checkVjOverlayText('a'.repeat(81)).failure?.code).toBe(
        'vj_overlay_text_too_long',
      );
      expect(checkVjOverlayText('a'.repeat(80)).value).toHaveLength(80);
    });

    it('answers each overlay field with its code', () => {
      const cases: [Record<string, unknown>, string, string][] = [
        [{ text: 7 }, 'vj_overlay_text_invalid', 'text'],
        [{ style: 'huge' }, 'vj_overlay_style_invalid', 'style'],
        [{ position: 'left' }, 'vj_overlay_position_invalid', 'position'],
        [{ size: 'xxl' }, 'vj_overlay_size_invalid', 'size'],
        [{ colorToken: 'teal' }, 'vj_color_token_invalid', 'colorToken'],
        [{ isVisible: 'true' }, 'vj_effect_flag_invalid', 'isVisible'],
      ];
      for (const [payload, code, path] of cases) {
        expect(
          checkVjOverlayFields(payload, { isComplete: false }).failure,
        ).toEqual({ code, path });
      }
    });

    it('accepts a partial overlay and leaves the blank check to the caller', () => {
      expect(
        checkVjOverlayFields(
          { isVisible: true, position: 'top', hideAfterMs: 5000 },
          { isComplete: false },
        ).value,
      ).toEqual({ isVisible: true, position: 'top' });
      expect(
        checkVjOverlayFields({ text: 'hi' }, { isComplete: true }).failure,
      ).toEqual({ code: 'vj_overlay_style_invalid', path: 'style' });
    });
  });

  describe('mix', () => {
    it('answers each mix field with its code', () => {
      expect(
        checkVjMixFields({ clipId: 'clip' }, { isComplete: false }).failure,
      ).toEqual({ code: 'vj_clip_not_found', path: 'clipId' });
      for (const amount of [1.005, Number.NaN, '0.5']) {
        expect(
          checkVjMixFields({ amount }, { isComplete: false }).failure,
        ).toEqual({ code: 'vj_mix_amount_invalid', path: 'amount' });
      }
      expect(
        checkVjMixFields({ blendMode: 'overlay' }, { isComplete: false })
          .failure,
      ).toEqual({ code: 'vj_blend_mode_invalid', path: 'blendMode' });
    });

    it('lowercases the clip id and rounds the amount', () => {
      expect(
        checkVjMixFields(
          { clipId: CLIP_ID.toUpperCase(), amount: 0.333 },
          { isComplete: false },
        ).value,
      ).toEqual({ clipId: CLIP_ID, amount: 0.33 });
      expect(
        checkVjMixFields({ clipId: null }, { isComplete: false }).value,
      ).toEqual({ clipId: null });
    });
  });

  describe('generator', () => {
    it('checks a generator id and its variant', () => {
      expect(
        checkVjGeneratorChoice('plasma', undefined, {
          isVariantRequired: false,
        }).value,
      ).toEqual({ generatorId: 'plasma', generatorVariant: null });
      expect(
        checkVjGeneratorChoice('prideFlagWave', 'trans', {
          isVariantRequired: true,
        }).value,
      ).toEqual({ generatorId: 'prideFlagWave', generatorVariant: 'trans' });
      expect(
        checkVjGeneratorChoice('plasma', 'trans', { isVariantRequired: false })
          .failure,
      ).toEqual({
        code: 'vj_generator_variant_invalid',
        path: 'generatorVariant',
      });
      expect(
        checkVjGeneratorChoice('prideFlagWave', undefined, {
          isVariantRequired: false,
        }).value,
      ).toEqual({ generatorId: 'prideFlagWave', generatorVariant: 'rainbow' });
    });

    it('refuses an unknown generator and a missing variant when required', () => {
      expect(
        checkVjGeneratorChoice('lava', null, { isVariantRequired: false })
          .failure,
      ).toEqual({ code: 'vj_generator_invalid', path: 'generatorId' });
      expect(
        checkVjGeneratorChoice('prideFlagWave', null, {
          isVariantRequired: false,
        }).failure?.code,
      ).toBe('vj_generator_variant_invalid');
      expect(
        checkVjGeneratorChoice('plasma', undefined, {
          isVariantRequired: true,
        }).failure?.code,
      ).toBe('vj_generator_variant_invalid');
    });
  });
});
