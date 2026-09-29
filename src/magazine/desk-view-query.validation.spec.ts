import { BadRequestException } from '@nestjs/common';
import { validateDeskViewQuery } from './desk-view-query.validation';

describe('validateDeskViewQuery', () => {
  it('accepts an empty query, the desk defaults', () => {
    expect(validateDeskViewQuery({})).toEqual({});
  });

  it('keeps every known key and returns a clean copy', () => {
    const input = {
      track: 'issue',
      focus: ['your-turn', 'late'],
      format: 'deck',
      sections: ['Features'],
      stages: ['Drafting', 'Edit'],
      editor: 'editor-1',
      sort: 'due',
      groupBy: 'waiting',
    };

    const query = validateDeskViewQuery(input);

    expect(query).toEqual(input);
    expect(query.focus).not.toBe(input.focus);
  });

  it('accepts a null editor, meaning everyone', () => {
    expect(validateDeskViewQuery({ editor: null })).toEqual({ editor: null });
  });

  it.each([
    ['a non-object', 'late'],
    ['an array', ['late']],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(() => validateDeskViewQuery(input)).toThrow(BadRequestException);
  });

  it('refuses an unknown key so the column stays a known shape', () => {
    expect(() => validateDeskViewQuery({ q: 'nightlife' })).toThrow(
      'query: unknown key "q"',
    );
  });

  it.each([
    ['track', { track: 'archive' }],
    ['format', { format: 'video' }],
    ['sort', { sort: 'title' }],
    ['groupBy', { groupBy: 'writer' }],
  ])('refuses an unknown %s value', (_key, input) => {
    expect(() => validateDeskViewQuery(input)).toThrow(BadRequestException);
  });

  it('refuses a list that is not all non-empty strings', () => {
    expect(() => validateDeskViewQuery({ focus: ['late', 3] })).toThrow(
      BadRequestException,
    );
    expect(() => validateDeskViewQuery({ sections: [''] })).toThrow(
      BadRequestException,
    );
    expect(() => validateDeskViewQuery({ stages: 'Edit' })).toThrow(
      BadRequestException,
    );
  });

  it('caps list length and entry length', () => {
    const tooMany = Array.from(
      { length: 21 },
      (_entry, position) => `s${position}`,
    );
    expect(() => validateDeskViewQuery({ sections: tooMany })).toThrow(
      BadRequestException,
    );
    expect(() => validateDeskViewQuery({ sections: ['x'.repeat(81)] })).toThrow(
      BadRequestException,
    );
  });

  it('refuses an editor that is neither a string id nor null', () => {
    expect(() => validateDeskViewQuery({ editor: 42 })).toThrow(
      BadRequestException,
    );
    expect(() => validateDeskViewQuery({ editor: '' })).toThrow(
      BadRequestException,
    );
  });
});
