import { HttpStatus } from '@nestjs/common';
import { STUDIO_ARTIST_PERSONA_KINDS } from '../studio/studio.constants';
import {
  PERSONA_POST,
  PERSONA_POST_AUDIT_ACTIONS,
  PERSONA_POST_ERROR_CODES,
  PERSONA_POST_KINDS,
  PERSONA_POST_QUOTA_WINDOW_MILLISECONDS,
  isPersonaPostKind,
  personaPostError,
  personaPostExcerpt,
} from './persona-post.constants';

describe('Persona post vocabulary', () => {
  it('holds the limits the v3 contract sets', () => {
    expect(PERSONA_POST).toEqual({
      bodyMax: 500,
      linkMax: 1000,
      dailyLimit: 10,
      alertsPerDay: 3,
      pageSize: 10,
      excerptMax: 80,
    });
    expect(PERSONA_POST_QUOTA_WINDOW_MILLISECONDS).toBe(24 * 60 * 60 * 1000);
    expect(PERSONA_POST_AUDIT_ACTIONS.removed).toBe('persona_post_removed');
  });

  it('opens posts to every Studio artist kind, read from the format map', () => {
    expect(PERSONA_POST_KINDS).toEqual(STUDIO_ARTIST_PERSONA_KINDS);
    expect(isPersonaPostKind('dj')).toBe(true);
    expect(isPersonaPostKind('musician')).toBe(true);
    expect(isPersonaPostKind('podcaster')).toBe(true);
    expect(isPersonaPostKind('drag')).toBe(true);
    expect(isPersonaPostKind('writer')).toBe(false);
  });
});

describe('personaPostError', () => {
  it.each([
    ['persona_posts_not_available', HttpStatus.UNPROCESSABLE_ENTITY],
    ['persona_post_image_not_allowed', HttpStatus.UNPROCESSABLE_ENTITY],
    ['persona_post_daily_limit', HttpStatus.TOO_MANY_REQUESTS],
  ] as const)(
    'answers %s with HTTP %i and the code in the body',
    (code, status) => {
      const exception = personaPostError(code);
      expect(exception.getStatus()).toBe(status);
      expect(exception.getResponse()).toEqual(
        expect.objectContaining({ statusCode: status, code }),
      );
    },
  );

  it('lists every code once', () => {
    expect(new Set(PERSONA_POST_ERROR_CODES).size).toBe(3);
  });
});

describe('personaPostExcerpt', () => {
  it('keeps a short body as it is, whitespace collapsed', () => {
    expect(personaPostExcerpt('  New single\n\nout   Friday  ')).toBe(
      'New single out Friday',
    );
  });

  it('cuts a long body on the last space within 80 characters and marks the cut', () => {
    const body = `${'word '.repeat(20)}tail`;
    const excerpt = personaPostExcerpt(body);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(81);
    expect(excerpt.slice(0, -1)).toBe('word '.repeat(16).trim());
  });

  it('cuts a body with no space at 80 characters', () => {
    expect(personaPostExcerpt('x'.repeat(120))).toBe(`${'x'.repeat(80)}…`);
  });

  it('keeps a word that ends exactly at the 80th character', () => {
    const body = `${'a'.repeat(80)} next`;
    expect(personaPostExcerpt(body)).toBe(`${'a'.repeat(80)}…`);
  });
});
