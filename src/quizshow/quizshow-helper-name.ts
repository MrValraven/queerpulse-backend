import { textHasBlockedTerm } from '../common/blocked-terms';
import { QUIZSHOW_LIMITS } from './quizshow.contract';

/**
 * A profile first name as a Pulse Live screen name: trimmed, cut to
 * `screenNameMax` and trimmed again, or blank when it is missing or holds a
 * blocked term. The gateway suggests it to a joining player.
 */
export function quizshowScreenNameFromFirstName(
  firstName: string | null | undefined,
): string {
  const screenName = (firstName ?? '')
    .trim()
    .slice(0, QUIZSHOW_LIMITS.screenNameMax)
    .trim();
  return textHasBlockedTerm(screenName) ? '' : screenName;
}

/**
 * The name a paired helper shows in the host's device list, or null when the
 * first name gives none. Pairing time (the gateway) and a reload (the
 * persistence load) both read it here, so a helper keeps one name across a
 * restart.
 */
export function quizshowHelperNameFromFirstName(
  firstName: string | null | undefined,
): string | null {
  const helperName = quizshowScreenNameFromFirstName(firstName);
  return helperName === '' ? null : helperName;
}
