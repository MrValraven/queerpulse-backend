import { BLOCKED_TERMS } from '../common/blocked-terms';
import {
  quizshowHelperNameFromFirstName,
  quizshowScreenNameFromFirstName,
} from './quizshow-helper-name';
import { QUIZSHOW_LIMITS } from './quizshow.contract';

const BLOCKED_FIRST_NAME = BLOCKED_TERMS[0] ?? '';

describe('Pulse Live helper and screen names from a first name', () => {
  it('trims the first name and cuts it to the screen name limit', () => {
    expect(quizshowScreenNameFromFirstName('  Philippine  ')).toBe(
      'Philippine',
    );
    const longName = `${'a'.repeat(QUIZSHOW_LIMITS.screenNameMax - 1)} bcd`;
    const cutName = quizshowScreenNameFromFirstName(longName);
    expect(cutName.length).toBeLessThanOrEqual(QUIZSHOW_LIMITS.screenNameMax);
    expect(cutName).toBe(cutName.trim());
  });

  it('reads a missing first name or one with a blocked term as blank', () => {
    expect(quizshowScreenNameFromFirstName(null)).toBe('');
    expect(quizshowScreenNameFromFirstName(undefined)).toBe('');
    expect(quizshowScreenNameFromFirstName('   ')).toBe('');
    expect(quizshowScreenNameFromFirstName(BLOCKED_FIRST_NAME)).toBe('');
  });

  it('gives a helper null where the screen name is blank, and the screen name otherwise', () => {
    expect(quizshowHelperNameFromFirstName(null)).toBeNull();
    expect(quizshowHelperNameFromFirstName('  ')).toBeNull();
    expect(quizshowHelperNameFromFirstName(BLOCKED_FIRST_NAME)).toBeNull();
    expect(quizshowHelperNameFromFirstName(' Alina ')).toBe('Alina');
  });
});
