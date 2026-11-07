import { BadRequestException } from '@nestjs/common';
import { validateDeskViewQuery } from './desk-view-query.validation';
import { MAGAZINE_ERROR_CODE } from './magazine-error-codes';

/** What `run` throws, or `undefined`, so a spec can assert its body `code`. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

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
    expect(thrownBy(() => validateDeskViewQuery(input))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
  });

  it('refuses an unknown key so the column stays a known shape', () => {
    expect(
      thrownBy(() => validateDeskViewQuery({ q: 'nightlife' })),
    ).toMatchObject({
      message: 'query: unknown key "q"',
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
  });

  it.each([
    ['track', { track: 'archive' }],
    ['format', { format: 'video' }],
    ['sort', { sort: 'title' }],
    ['groupBy', { groupBy: 'writer' }],
  ])('refuses an unknown %s value', (_key, input) => {
    expect(thrownBy(() => validateDeskViewQuery(input))).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
  });

  it('refuses a list that is not all non-empty strings', () => {
    expect(
      thrownBy(() => validateDeskViewQuery({ focus: ['late', 3] })),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
    expect(
      thrownBy(() => validateDeskViewQuery({ sections: [''] })),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
    expect(
      thrownBy(() => validateDeskViewQuery({ stages: 'Edit' })),
    ).toMatchObject({
      constructor: BadRequestException,
      response: { code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID },
    });
  });

  it('caps list length and entry length', () => {
    const tooMany = Array.from(
      { length: 21 },
      (_entry, position) => `s${position}`,
    );
    expect(
      thrownBy(() => validateDeskViewQuery({ sections: tooMany })),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_TOO_LARGE,
      },
    });
    expect(
      thrownBy(() => validateDeskViewQuery({ sections: ['x'.repeat(81)] })),
    ).toMatchObject({
      constructor: BadRequestException,
      response: {
        code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_TOO_LARGE,
      },
    });
  });

  it('refuses an editor that is neither a string id nor null', () => {
    expect(thrownBy(() => validateDeskViewQuery({ editor: 42 }))).toMatchObject(
      {
        constructor: BadRequestException,
        response: {
          code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID,
        },
      },
    );
    expect(thrownBy(() => validateDeskViewQuery({ editor: '' }))).toMatchObject(
      {
        constructor: BadRequestException,
        response: {
          code: MAGAZINE_ERROR_CODE.MAGAZINE_DESK_VIEW_QUERY_INVALID,
        },
      },
    );
  });
});
