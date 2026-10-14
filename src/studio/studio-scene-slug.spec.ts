import {
  SCENE_SLUG_FALLBACK_BASE,
  sceneSlugBase,
  sceneSlugCandidates,
} from './studio-scene-slug';
import { STUDIO_SCENE_SLUG_PATTERN } from './studio.constants';

describe('sceneSlugBase', () => {
  it('folds accents, lowercases and joins every other run with one hyphen', () => {
    expect(sceneSlugBase('  Lisboa: Ballroom & Vogue!  ')).toBe(
      'lisboa-ballroom-vogue',
    );
    expect(sceneSlugBase('São João')).toBe('sao-joao');
  });

  it('cuts at 60 characters and leaves no trailing hyphen', () => {
    const base = sceneSlugBase(`${'a'.repeat(59)} b`);
    expect(base).toBe('a'.repeat(59));
    expect(base.length).toBeLessThanOrEqual(60);
  });

  it('uses the fallback base for a name that folds to under 2 characters', () => {
    expect(sceneSlugBase('!!')).toBe(SCENE_SLUG_FALLBACK_BASE);
    expect(sceneSlugBase('Á')).toBe(SCENE_SLUG_FALLBACK_BASE);
  });

  it('always answers a slug the pattern accepts', () => {
    for (const name of ['Porto', 'Noites de fado', '--x--y--', 'Club 2000']) {
      expect(STUDIO_SCENE_SLUG_PATTERN.test(sceneSlugBase(name))).toBe(true);
    }
  });
});

describe('sceneSlugCandidates', () => {
  it('tries the base, then -2 up to -50', () => {
    const candidates = sceneSlugCandidates('porto');
    expect(candidates.slice(0, 3)).toEqual(['porto', 'porto-2', 'porto-3']);
    expect(candidates).toHaveLength(50);
    expect(candidates[49]).toBe('porto-50');
  });

  it('shortens a long base so every suffixed slug fits in 60', () => {
    for (const candidate of sceneSlugCandidates('a'.repeat(60))) {
      expect(candidate.length).toBeLessThanOrEqual(60);
      expect(STUDIO_SCENE_SLUG_PATTERN.test(candidate)).toBe(true);
    }
  });
});
