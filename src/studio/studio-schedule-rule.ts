import {
  STUDIO_SCHEDULE_MAX_LEAD_DAYS,
  STUDIO_SCHEDULE_MIN_LEAD_MINUTES,
  STUDIO_SCHEDULE_TIME_ZONE,
} from './studio.constants';

const MILLISECONDS_PER_MINUTE = 60_000;
const MILLISECONDS_PER_DAY = 86_400_000;

/** Studio v3: a scheduled release goes live 15 minutes to 365 days ahead of
 *  the server clock, both ends included. */
export function isWithinScheduleWindow(publishAt: Date, now: Date): boolean {
  const leadMilliseconds = publishAt.getTime() - now.getTime();
  return (
    leadMilliseconds >=
      STUDIO_SCHEDULE_MIN_LEAD_MINUTES * MILLISECONDS_PER_MINUTE &&
    leadMilliseconds <= STUDIO_SCHEDULE_MAX_LEAD_DAYS * MILLISECONDS_PER_DAY
  );
}

const LISBON_DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: STUDIO_SCHEDULE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** `YYYY-MM-DD` of `moment` in Lisbon, used to fill an empty
 *  `released_on` from a scheduled time. */
export function scheduleDateInLisbon(moment: Date): string {
  const parts = LISBON_DATE_FORMAT.formatToParts(moment);
  const partOf = (partType: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === partType)?.value ?? '';
  return `${partOf('year')}-${partOf('month')}-${partOf('day')}`;
}
