import { describePlayErrorWithoutIds } from './studio-play-log';

const TRACK_ID = '33333333-3333-4333-8333-333333333333';

describe('describePlayErrorWithoutIds', () => {
  it('names the error class and the Postgres code and leaves the message out', () => {
    const error = Object.assign(
      new Error(`Key (track_id)=(${TRACK_ID}) is not present`),
      { code: '23503' },
    );
    expect(describePlayErrorWithoutIds(error)).toBe('Error (code 23503)');
  });

  it('names only the class when the error carries no code', () => {
    expect(describePlayErrorWithoutIds(new TypeError(TRACK_ID))).toBe(
      'TypeError',
    );
  });

  it('reads anything else as an unknown error', () => {
    expect(describePlayErrorWithoutIds('boom')).toBe('unknown error');
  });
});
