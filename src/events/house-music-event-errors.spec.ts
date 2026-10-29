import { HttpException, HttpStatus } from '@nestjs/common';
import {
  HOUSE_MUSIC_EVENT_ERRORS,
  HouseMusicEventErrorCode,
  houseMusicEventError,
} from './house-music-event-errors';

describe('house music event errors', () => {
  it('gives every code a status and a message that says event', () => {
    const entries = Object.entries(HOUSE_MUSIC_EVENT_ERRORS);
    expect(entries).toHaveLength(10);
    for (const [, definition] of entries) {
      expect(Object.values(HttpStatus)).toContain(definition.status);
      expect(definition.message).toMatch(/event|member|lineup|co-host|invite/i);
      expect(definition.message).not.toMatch(/gathering/i);
    }
  });

  it('builds an HttpException whose body carries statusCode, code and message', () => {
    const code: HouseMusicEventErrorCode = 'music_event_not_found';
    const error = houseMusicEventError(code);
    expect(error).toBeInstanceOf(HttpException);
    expect(error.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(error.getResponse()).toEqual({
      statusCode: HttpStatus.NOT_FOUND,
      code,
      message: 'This event is not one QueerPulse hosts in Music.',
    });

    const forbidden = houseMusicEventError('music_event_cohost_holds_grant');
    expect(forbidden.getStatus()).toBe(HttpStatus.FORBIDDEN);
    expect(forbidden.getResponse()).toEqual({
      statusCode: HttpStatus.FORBIDDEN,
      code: 'music_event_cohost_holds_grant',
      message:
        'A music manager and producer cannot co-host a QueerPulse music event.',
    });
  });
});
