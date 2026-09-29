import { maxLength } from 'class-validator';
import {
  countCharacters,
  removeLoneSurrogates,
  truncateCharacters,
  widenToCodePointBoundaries,
} from './text-characters';

const GRINNING_FACE = '\u{1F600}';
const HIGH_HALF = '\uD83D';
const LOW_HALF = '\uDE00';
const RED_HEART_EMOJI_FORM = '❤️';

/** Postgres refuses a `jsonb` value whose JSON text holds a lone surrogate escape. */
const hasLoneSurrogateEscape = (value: unknown): boolean =>
  /\\ud[89a-f][0-9a-f]{2}/i.test(JSON.stringify(value));

describe('countCharacters', () => {
  it('counts an emoji as one character, like class-validator', () => {
    const caption = 'a'.repeat(999) + GRINNING_FACE;
    expect(caption.length).toBe(1001);
    expect(countCharacters(caption)).toBe(1000);
    expect(maxLength(caption, 1000)).toBe(true);
  });

  it('counts a presentation selector as zero, like class-validator', () => {
    const hearts = RED_HEART_EMOJI_FORM.repeat(10);
    expect(countCharacters(hearts)).toBe(10);
    expect(maxLength(hearts, 10)).toBe(true);
    expect(maxLength(hearts, 9)).toBe(false);
  });
});

describe('truncateCharacters', () => {
  it('keeps a caption of exactly the bound whole when it ends in an emoji', () => {
    const caption = 'a'.repeat(999) + GRINNING_FACE;
    expect(truncateCharacters(caption, 1000)).toBe(caption);
  });

  it('drops a whole emoji that sits past the bound and leaves no lone half', () => {
    const caption = 'a'.repeat(1000) + GRINNING_FACE;
    const cut = truncateCharacters(caption, 1000);
    expect(cut).toBe('a'.repeat(1000));
    expect(hasLoneSurrogateEscape({ caption: cut })).toBe(false);
  });

  it('keeps every emoji of an emoji-only caption within the bound', () => {
    const caption = GRINNING_FACE.repeat(1000);
    expect(caption.length).toBe(2000);
    expect(truncateCharacters(caption, 1000)).toBe(caption);
  });

  it('cuts an emoji-only caption on a pair boundary', () => {
    const cut = truncateCharacters(GRINNING_FACE.repeat(5), 3);
    expect(cut).toBe(GRINNING_FACE.repeat(3));
    expect(hasLoneSurrogateEscape(cut)).toBe(false);
  });

  it('keeps the presentation selector with the last kept heart', () => {
    const cut = truncateCharacters(RED_HEART_EMOJI_FORM.repeat(5), 2);
    expect(cut).toBe(RED_HEART_EMOJI_FORM.repeat(2));
  });

  it('removes a lone surrogate the input arrived with', () => {
    expect(truncateCharacters(`hi${HIGH_HALF}`, 140)).toBe('hi');
    expect(truncateCharacters(`${LOW_HALF}hi`, 140)).toBe('hi');
  });

  it('leaves plain text under the bound unchanged', () => {
    expect(truncateCharacters('Sunset at the pier', 140)).toBe(
      'Sunset at the pier',
    );
  });
});

describe('removeLoneSurrogates', () => {
  it('keeps a whole pair and drops each unpaired half', () => {
    expect(
      removeLoneSurrogates(`${HIGH_HALF}a${GRINNING_FACE}b${LOW_HALF}`),
    ).toBe(`a${GRINNING_FACE}b`);
  });
});

describe('widenToCodePointBoundaries', () => {
  it('moves a start inside a pair back onto the high half', () => {
    const text = `ab${GRINNING_FACE}cd`;
    expect(widenToCodePointBoundaries(text, 3, text.length)).toEqual({
      start: 2,
      end: text.length,
    });
  });

  it('moves an end inside a pair past the low half', () => {
    const text = `ab${GRINNING_FACE}cd`;
    const { start, end } = widenToCodePointBoundaries(text, 0, 3);
    expect(end).toBe(4);
    expect(text.slice(start, end)).toBe(`ab${GRINNING_FACE}`);
  });

  it('leaves boundaries that already sit between code points alone', () => {
    const text = `ab${GRINNING_FACE}cd`;
    expect(widenToCodePointBoundaries(text, 2, 4)).toEqual({
      start: 2,
      end: 4,
    });
  });
});
