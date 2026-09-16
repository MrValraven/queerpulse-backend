import { ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';

/**
 * PRD-365: first-contact volume caps, in one place so the numbers a moderator
 * asks about and the numbers the code enforces can never drift apart.
 *
 * Every connection request counts, including the ones a message request
 * (`MessageRequestsService.messageRequest`) seeds, because both reach
 * `ConnectionsService.requestConnection`. Housing and listing enquiries
 * (`MessageRequestsService.deliverEnquiry`) are exempt from the two volume caps
 * (each enquiry domain keeps its own quota) and are still subject to the
 * report-driven pause.
 */

/** Connection requests a member may create in any rolling 24 hours. */
export const MAX_NEW_CONNECTION_REQUESTS_PER_DAY = 20;

/** Outstanding `pending` requests a member may have sent at once. */
export const MAX_OPEN_PENDING_REQUESTS = 40;

/** Distinct signed-in reporters with a live report that pause new requests. */
export const REQUEST_PAUSE_DISTINCT_REPORTERS = 3;

/** How far back a live report counts toward the pause. */
export const REQUEST_PAUSE_REPORT_WINDOW_DAYS = 7;

/** Rolling window of {@link MAX_NEW_CONNECTION_REQUESTS_PER_DAY}. */
export const CONNECTION_REQUEST_DAILY_WINDOW_HOURS = 24;

/** 429: the member reached {@link MAX_NEW_CONNECTION_REQUESTS_PER_DAY}. */
export const CONNECTION_REQUEST_DAILY_LIMIT_CODE =
  'CONNECTION_REQUEST_DAILY_LIMIT';

/** 429: the member reached {@link MAX_OPEN_PENDING_REQUESTS}. */
export const CONNECTION_REQUEST_PENDING_LIMIT_CODE =
  'CONNECTION_REQUEST_PENDING_LIMIT';

/** 403: live reports from several members pause new first contact. */
export const CONNECTION_REQUESTS_PAUSED_CODE = 'CONNECTION_REQUESTS_PAUSED';

/** 403 (PRD-366): the recipient's "who can message me" refuses new requests. */
export const RECIPIENT_NOT_ACCEPTING_REQUESTS_CODE =
  'RECIPIENT_NOT_ACCEPTING_REQUESTS';

export function connectionRequestDailyLimitException(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message:
        'You have sent a lot of new requests today. You can send more tomorrow.',
      code: CONNECTION_REQUEST_DAILY_LIMIT_CODE,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function connectionRequestPendingLimitException(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      message:
        'You have many requests still waiting for an answer. You can send more once some are answered or withdrawn.',
      code: CONNECTION_REQUEST_PENDING_LIMIT_CODE,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export function connectionRequestsPausedException(): ForbiddenException {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    message:
      'New requests are paused on your account for now while our moderators look into something.',
    code: CONNECTION_REQUESTS_PAUSED_CODE,
  });
}

export function recipientNotAcceptingRequestsException(): ForbiddenException {
  return new ForbiddenException({
    statusCode: HttpStatus.FORBIDDEN,
    message:
      'This member is only accepting messages from their connections right now',
    code: RECIPIENT_NOT_ACCEPTING_REQUESTS_CODE,
  });
}
