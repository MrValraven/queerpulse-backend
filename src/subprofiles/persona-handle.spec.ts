import { ConflictException } from '@nestjs/common';
import {
  deriveLinkedPersonaHandle,
  handleIsKindName,
  handleNamesOwner,
  linkedPersonaHandleCandidate,
} from './persona-handle';

describe('linkedPersonaHandleCandidate', () => {
  it('joins creator and persona slugs', () => {
    expect(linkedPersonaHandleCandidate('tiago-costa', 'therapist')).toBe(
      'tiago-costa-therapist',
    );
  });

  it('adds a numeric suffix from 2 upward', () => {
    expect(linkedPersonaHandleCandidate('tiago-costa', 'therapist', 2)).toBe(
      'tiago-costa-therapist-2',
    );
  });

  it('cuts the persona part to fit 30 chars and drops a dangling hyphen', () => {
    const candidate = linkedPersonaHandleCandidate(
      'tiago-costa',
      'community-organiser-and-facilitator',
    );
    expect(candidate.length).toBeLessThanOrEqual(30);
    expect(candidate.startsWith('tiago-costa-')).toBe(true);
    expect(candidate).not.toMatch(/-$/);
    expect(candidate).not.toMatch(/--/);
  });

  it('drops a hyphen that lands exactly on the cut boundary', () => {
    // creatorSlug 'tiago-costa' is 11 chars, so at suffix 1 (budget 30) the
    // persona room is max(3, 30 - 11 - 1) = 18: slice(0, 18) keeps indices
    // 0..17. This persona slug puts a hyphen at index 17 (17 'a's, then '-',
    // then 'bbbb'), exactly where the cut lands, so the raw slice ends in a
    // dangling hyphen that trimHyphens must strip before the join.
    const personaSlug = `${'a'.repeat(17)}-bbbb`;
    const candidate = linkedPersonaHandleCandidate('tiago-costa', personaSlug);
    expect(candidate).toBe(`tiago-costa-${'a'.repeat(17)}`);
    expect(candidate).not.toMatch(/-$/);
    expect(candidate).not.toMatch(/--/);
  });

  it('keeps at least 3 persona chars when the creator slug is long', () => {
    const creatorSlug = 'a-very-long-creator-slug-xyz'; // 28 chars
    const candidate = linkedPersonaHandleCandidate(
      creatorSlug,
      'therapist',
      12,
    );
    expect(candidate.length).toBeLessThanOrEqual(30);
    expect(candidate).toMatch(/-the-12$/);
    expect(candidate).toMatch(/^[a-z0-9][a-z0-9-]{2,29}$/);
    expect(candidate).not.toMatch(/--/);
  });

  it('lowercases a mixed-case creator slug', () => {
    expect(linkedPersonaHandleCandidate('John', 'poet')).toBe('john-poet');
  });
});

describe('deriveLinkedPersonaHandle', () => {
  it('returns the first available candidate', async () => {
    const takenNames = new Set(['tiago-costa-therapist']);
    const handle = await deriveLinkedPersonaHandle(
      'tiago-costa',
      'therapist',
      async (candidate) => !takenNames.has(candidate),
    );
    expect(handle).toBe('tiago-costa-therapist-2');
  });

  it('throws handle_derivation_failed once every suffix is taken', async () => {
    await expect(
      deriveLinkedPersonaHandle('tiago-costa', 'therapist', async () => false),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('handleNamesOwner', () => {
  it('matches the creator slug as a hyphen-delimited run', () => {
    expect(handleNamesOwner('tiago-costa-therapist', 'tiago-costa')).toBe(true);
    expect(handleNamesOwner('the-tiago-costa', 'tiago-costa')).toBe(true);
  });

  it('matches the creator slug with its hyphens squashed', () => {
    expect(handleNamesOwner('tiagocosta-art', 'tiago-costa')).toBe(true);
  });

  it('ignores a partial overlap', () => {
    expect(handleNamesOwner('tiago-art', 'tiago-costa')).toBe(false);
    expect(handleNamesOwner('nightform', 'tiago-costa')).toBe(false);
  });
});

describe('handleIsKindName', () => {
  it('matches the kind id and its EN or PT label', () => {
    expect(handleIsKindName('therapist', 'therapist')).toBe(true);
    expect(handleIsKindName('terapia', 'therapist')).toBe(true);
    expect(handleIsKindName('visual-artist', 'visual_artist')).toBe(true);
    expect(handleIsKindName('arte-visual', 'visual_artist')).toBe(true);
  });

  it('trims and lowercases the handle first', () => {
    expect(handleIsKindName('Therapist ', 'therapist')).toBe(true);
  });

  it('folds accents in the label', () => {
    expect(handleIsKindName('ceramica', 'ceramicist')).toBe(true);
  });

  it('passes a handle that names the persona or another kind', () => {
    expect(handleIsKindName('tiago-therapist', 'therapist')).toBe(false);
    expect(handleIsKindName('therapist', 'dj')).toBe(false);
    expect(handleIsKindName('', 'therapist')).toBe(false);
  });
});
