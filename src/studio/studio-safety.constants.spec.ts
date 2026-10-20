import { HttpStatus } from '@nestjs/common';
import {
  STUDIO_CLAIMANT_ROLES,
  STUDIO_CLAIM_HOLDING_LIST_SQL,
  STUDIO_CLAIM_HOLDING_STATUSES,
  STUDIO_CLAIM_WITHHOLDING_LIST_SQL,
  STUDIO_CLAIM_WITHHOLDING_STATUSES,
  STUDIO_CLAIM_LIMITS,
  STUDIO_CLAIM_LIVE_LIST_SQL,
  STUDIO_CLAIM_LIVE_STATUSES,
  STUDIO_CLAIM_OWNER_VISIBLE_STATUSES,
  STUDIO_CLAIM_STATUSES,
  STUDIO_CONTENT_WARNINGS_MAX,
  STUDIO_CONTENT_WARNING_IDS,
  STUDIO_CONTENT_WARNING_LIST_SQL,
  STUDIO_SAFETY_AUDIT_ACTIONS,
  STUDIO_SAFETY_ERROR_CODES,
  StudioSafetyErrorCode,
  effectiveContentWarnings,
  isStudioContentWarningId,
  normalizeContentWarnings,
  studioSafetyError,
} from './studio-safety.constants';

describe('Studio safety vocabulary', () => {
  it('lists the eight forum themes in the contract order', () => {
    expect(STUDIO_CONTENT_WARNING_IDS).toEqual([
      'medical',
      'violence',
      'substances',
      'family-rejection',
      'sexual-content',
      'self-harm',
      'housing-loss',
      'police',
    ]);
    expect(STUDIO_CONTENT_WARNINGS_MAX).toBe(8);
    expect(STUDIO_CONTENT_WARNING_LIST_SQL).toBe(
      "'medical', 'violence', 'substances', 'family-rejection', 'sexual-content', 'self-harm', 'housing-loss', 'police'",
    );
  });

  it('spells the claim statuses and their groups as the contract does', () => {
    expect(STUDIO_CLAIM_STATUSES).toEqual([
      'submitted',
      'accepted',
      'declined',
      'countered',
      'upheld',
      'rejected',
      'withdrawn',
    ]);
    expect(STUDIO_CLAIM_LIVE_STATUSES).toEqual([
      'submitted',
      'accepted',
      'countered',
    ]);
    expect(STUDIO_CLAIM_OWNER_VISIBLE_STATUSES).toEqual([
      'accepted',
      'countered',
      'upheld',
      'rejected',
    ]);
    expect(STUDIO_CLAIM_HOLDING_STATUSES).toEqual(['accepted', 'countered']);
    expect(STUDIO_CLAIM_HOLDING_LIST_SQL).toBe("'accepted', 'countered'");
    expect(STUDIO_CLAIM_WITHHOLDING_STATUSES).toEqual([
      'accepted',
      'countered',
      'upheld',
    ]);
    expect(STUDIO_CLAIM_WITHHOLDING_LIST_SQL).toBe(
      "'accepted', 'countered', 'upheld'",
    );
    expect(STUDIO_CLAIM_LIVE_LIST_SQL).toBe(
      "'submitted', 'accepted', 'countered'",
    );
    expect(STUDIO_CLAIMANT_ROLES).toEqual(['rights_holder', 'authorised']);
  });

  it('holds the contract limits', () => {
    expect(STUDIO_CLAIM_LIMITS).toEqual({
      originalWorkMax: 200,
      originalLinkMax: 500,
      detailsMax: 2000,
      counterNoteMax: 2000,
      replyMax: 1000,
      staffNoteMax: 1000,
      liveClaimsPerClaimant: 10,
      filingsPerHour: 3,
      pageSize: 20,
    });
  });

  it('knows the theme ids and nothing else', () => {
    expect(isStudioContentWarningId('police')).toBe(true);
    expect(isStudioContentWarningId('Police')).toBe(false);
    expect(isStudioContentWarningId('gore')).toBe(false);
  });

  it('keeps known ids once each, in theme order', () => {
    expect(
      normalizeContentWarnings(['police', 'medical', 'gore', 'police']),
    ).toEqual(['medical', 'police']);
    expect(normalizeContentWarnings([])).toEqual([]);
    expect(normalizeContentWarnings(null)).toEqual([]);
    expect(normalizeContentWarnings(undefined)).toEqual([]);
  });

  it('shows listeners the artist and staff warnings together, each once', () => {
    expect(
      effectiveContentWarnings(['self-harm', 'medical'], ['medical', 'police']),
    ).toEqual(['medical', 'self-harm', 'police']);
    expect(effectiveContentWarnings(undefined, null)).toEqual([]);
  });

  it('answers each refusal with its status and the contract message', () => {
    const expected: Record<StudioSafetyErrorCode, [HttpStatus, string]> = {
      studio_track_withheld: [HttpStatus.GONE, 'This track is unavailable.'],
      studio_track_explicit_locked: [
        HttpStatus.CONFLICT,
        'Our team marked this track explicit, so it stays marked.',
      ],
      studio_use_copyright_claim: [
        HttpStatus.UNPROCESSABLE_ENTITY,
        'Copyright claims have their own form.',
      ],
      studio_claim_own_track: [
        HttpStatus.CONFLICT,
        "You can't file a copyright claim about your own track.",
      ],
      studio_claim_exists: [
        HttpStatus.CONFLICT,
        'You already have an open claim about this track.',
      ],
      studio_claim_limit: [
        HttpStatus.CONFLICT,
        'You can have up to 10 open claims at a time.',
      ],
      studio_claim_not_countered: [
        HttpStatus.CONFLICT,
        'You can reply once the artist sends a counter-notice.',
      ],
      studio_claim_already_replied: [
        HttpStatus.CONFLICT,
        'You already replied to this counter-notice.',
      ],
      studio_claim_not_live: [
        HttpStatus.CONFLICT,
        'This claim is already closed.',
      ],
      studio_claim_not_accepted: [
        HttpStatus.CONFLICT,
        'A counter-notice goes in once, while the track is held.',
      ],
      studio_claim_not_submitted: [
        HttpStatus.CONFLICT,
        'Our team already checked this claim.',
      ],
      studio_claim_not_decidable: [
        HttpStatus.CONFLICT,
        'Our team can uphold or reject a claim once it is accepted.',
      ],
      studio_track_report_mismatch: [
        HttpStatus.UNPROCESSABLE_ENTITY,
        'That report is not a Studio report about this track.',
      ],
      studio_track_report_not_open: [
        HttpStatus.CONFLICT,
        'That report was already handled.',
      ],
    };
    expect([...STUDIO_SAFETY_ERROR_CODES].sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const code of STUDIO_SAFETY_ERROR_CODES) {
      const [status, message] = expected[code];
      const error = studioSafetyError(code);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        code,
        message,
      });
    }
  });

  it('names nothing in the withheld 410 body', () => {
    expect(studioSafetyError('studio_track_withheld').getResponse()).toEqual({
      statusCode: 410,
      code: 'studio_track_withheld',
      message: 'This track is unavailable.',
    });
  });

  it('writes every refusal without dashes', () => {
    for (const code of STUDIO_SAFETY_ERROR_CODES) {
      const { message } = studioSafetyError(code).getResponse() as {
        message: string;
      };
      expect(message).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it('spells the six audit actions', () => {
    expect(STUDIO_SAFETY_AUDIT_ACTIONS).toEqual({
      trackMarkedExplicit: 'studio_track_marked_explicit',
      trackWarningAdded: 'studio_track_warning_added',
      claimAccepted: 'studio_copyright_claim_accepted',
      claimDeclined: 'studio_copyright_claim_declined',
      claimUpheld: 'studio_copyright_claim_upheld',
      claimRejected: 'studio_copyright_claim_rejected',
    });
  });
});
