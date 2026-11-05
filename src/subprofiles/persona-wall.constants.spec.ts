import { HttpStatus } from '@nestjs/common';
import {
  DEFAULT_PERSONA_WALL_FILL_ORDER,
  PERSONA_WALL_FILL_ORDERS,
  PERSONA_WALL_MAX_PICKS,
  PERSONA_WALL_REFUSALS,
  PERSONA_WALL_SEARCH_LIMIT,
  personaWallError,
} from './persona-wall.constants';

describe('personaWallError', () => {
  it.each([
    ['PERSONA_WALL_FULL', 409],
    ['PERSONA_WALL_ALREADY_PICKED', 409],
    ['PERSONA_WALL_PERSONA_NOT_FOUND', 404],
    ['PERSONA_WALL_NOT_LISTED', 409],
    ['PERSONA_WALL_PICK_NOT_FOUND', 404],
    ['PERSONA_WALL_REORDER_MISMATCH', 409],
    ['PERSONA_WALL_INVALID_FILL_ORDER', 400],
  ] as const)(
    'answers %s with status %i and the code in the body',
    (code, status) => {
      const error = personaWallError(code);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        message: PERSONA_WALL_REFUSALS[code].message,
        code,
      });
    },
  );

  it('answers a malformed persona id with 400 and the same code', () => {
    const error = personaWallError('PERSONA_WALL_PERSONA_NOT_FOUND', {
      status: HttpStatus.BAD_REQUEST,
    });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      message: 'No persona has this id.',
      code: 'PERSONA_WALL_PERSONA_NOT_FOUND',
    });
  });

  it('names the hidden state on PERSONA_WALL_NOT_LISTED', () => {
    expect(
      personaWallError('PERSONA_WALL_NOT_LISTED', {
        publicState: 'draft',
      }).getResponse(),
    ).toEqual({
      statusCode: 409,
      message: "This persona is a draft, so it can't go on the wall.",
      code: 'PERSONA_WALL_NOT_LISTED',
      publicState: 'draft',
    });
  });

  it('gives every code its own message', () => {
    const messages = Object.values(PERSONA_WALL_REFUSALS).map(
      (refusal) => refusal.message,
    );
    expect(messages).toHaveLength(7);
    expect(new Set(messages).size).toBe(7);
  });
});

describe('persona wall constants', () => {
  it('match the contract', () => {
    expect(PERSONA_WALL_MAX_PICKS).toBe(9);
    expect(PERSONA_WALL_SEARCH_LIMIT).toBe(20);
    expect(PERSONA_WALL_FILL_ORDERS).toEqual([
      'endorsed',
      'followed',
      'newest',
      'daily_shuffle',
    ]);
    expect(DEFAULT_PERSONA_WALL_FILL_ORDER).toBe('endorsed');
  });
});
