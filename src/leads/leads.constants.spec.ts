import { HttpStatus } from '@nestjs/common';
import {
  DEFAULT_LEAD_STAGE,
  LEAD_EMAIL_MAX,
  LEAD_ENTRY_KINDS,
  LEAD_FOLLOW_UP_MAX,
  LEAD_FOLLOW_UP_MIN,
  LEAD_LINK_MAX,
  LEAD_LINKS_MAX,
  LEAD_LIST_LINKS_SHOWN,
  LEAD_LOCATION_MAX,
  LEAD_NAME_MAX,
  LEAD_NOTE_MAX,
  LEAD_PAGE_SIZE,
  LEAD_PERSONA_SEARCH_LIMIT,
  LEAD_PHONE_MAX,
  LEAD_REFUSALS,
  LEAD_SEARCH_QUERY_MAX,
  LEAD_STAGES,
  LEAD_TIME_ZONE,
  LEAD_TYPES,
  OPEN_LEAD_STAGES,
  leadError,
  type LeadRefusalCode,
} from './leads.constants';

const LEAD_ID = '7c1e2f4a-3b5d-4e6f-8a9b-0c1d2e3f4a5b';

describe('leadError', () => {
  it.each([
    ['LEAD_NOT_FOUND', 404],
    ['LEAD_NAME_REQUIRED', 400],
    ['LEAD_NAME_TOO_LONG', 400],
    ['LEAD_TYPE_INVALID', 400],
    ['LEAD_STAGE_INVALID', 400],
    ['LEAD_LOCATION_TOO_LONG', 400],
    ['LEAD_EMAIL_INVALID', 400],
    ['LEAD_EMAIL_TAKEN', 409],
    ['LEAD_PHONE_TOO_LONG', 400],
    ['LEAD_LINK_INVALID', 400],
    ['LEAD_LINK_TOO_LONG', 400],
    ['LEAD_TOO_MANY_LINKS', 400],
    ['LEAD_LINK_TAKEN', 409],
    ['LEAD_FOLLOW_UP_INVALID', 400],
    ['LEAD_PERSONA_NOT_FOUND', 404],
    ['LEAD_PERSONA_NOT_LISTED', 409],
    ['LEAD_PERSONA_TAKEN', 409],
    ['LEAD_NOTE_EMPTY', 400],
    ['LEAD_NOTE_TOO_LONG', 400],
    ['LEAD_NOTE_NOT_FOUND', 404],
    ['LEAD_NOTE_NOT_YOURS', 403],
    ['LEAD_ENTRY_NOT_EDITABLE', 409],
    ['LEAD_CURSOR_INVALID', 400],
  ] as const)(
    'answers %s with status %i and the code in the body',
    (code, status) => {
      const error = leadError(code);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        message: LEAD_REFUSALS[code].message,
        code,
      });
    },
  );

  it('copies only the extras listed for the code', () => {
    const options = {
      leadId: LEAD_ID,
      leadName: 'Ana Dj',
      index: 2,
      publicState: 'draft',
    } as const;
    expect(leadError('LEAD_EMAIL_TAKEN', options).getResponse()).toEqual({
      statusCode: 409,
      message: LEAD_REFUSALS.LEAD_EMAIL_TAKEN.message,
      code: 'LEAD_EMAIL_TAKEN',
      leadId: LEAD_ID,
      leadName: 'Ana Dj',
    });
    expect(leadError('LEAD_LINK_TAKEN', options).getResponse()).toEqual({
      statusCode: 409,
      message: LEAD_REFUSALS.LEAD_LINK_TAKEN.message,
      code: 'LEAD_LINK_TAKEN',
      leadId: LEAD_ID,
      leadName: 'Ana Dj',
      index: 2,
    });
    expect(leadError('LEAD_LINK_INVALID', options).getResponse()).toEqual({
      statusCode: 400,
      message: LEAD_REFUSALS.LEAD_LINK_INVALID.message,
      code: 'LEAD_LINK_INVALID',
      index: 2,
    });
    expect(leadError('LEAD_NOT_FOUND', options).getResponse()).toEqual({
      statusCode: 404,
      message: LEAD_REFUSALS.LEAD_NOT_FOUND.message,
      code: 'LEAD_NOT_FOUND',
    });
  });

  it('carries index -1 when links is no array', () => {
    expect(
      leadError('LEAD_LINK_INVALID', { index: -1 }).getResponse(),
    ).toMatchObject({ code: 'LEAD_LINK_INVALID', index: -1 });
  });

  it('names the hidden state on LEAD_PERSONA_NOT_LISTED', () => {
    expect(
      leadError('LEAD_PERSONA_NOT_LISTED', {
        publicState: 'taken_down',
      }).getResponse(),
    ).toEqual({
      statusCode: 409,
      message:
        "This persona was taken down by a moderator, so it can't be linked to a lead.",
      code: 'LEAD_PERSONA_NOT_LISTED',
      publicState: 'taken_down',
    });
  });

  it('keeps the general message on LEAD_PERSONA_NOT_LISTED with no state', () => {
    expect(leadError('LEAD_PERSONA_NOT_LISTED').getResponse()).toEqual({
      statusCode: 409,
      message: LEAD_REFUSALS.LEAD_PERSONA_NOT_LISTED.message,
      code: 'LEAD_PERSONA_NOT_LISTED',
    });
  });

  it('answers a malformed persona id with 400 and the same code', () => {
    const error = leadError('LEAD_PERSONA_NOT_FOUND', {
      status: HttpStatus.BAD_REQUEST,
    });
    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toMatchObject({
      statusCode: 400,
      code: 'LEAD_PERSONA_NOT_FOUND',
    });
  });

  it('keeps every message a fixed sentence that echoes no option', () => {
    for (const code of Object.keys(LEAD_REFUSALS) as LeadRefusalCode[]) {
      const body = leadError(code, {
        leadId: LEAD_ID,
        leadName: 'Secret Name',
      }).getResponse() as { message: string };
      expect(body.message).not.toContain('Secret Name');
      expect(body.message).not.toContain(LEAD_ID);
    }
    expect(
      new Set(Object.values(LEAD_REFUSALS).map(({ message }) => message)).size,
    ).toBe(23);
  });
});

describe('lead constants', () => {
  it('match the contract', () => {
    expect(LEAD_TYPES).toEqual([
      'artist',
      'dj',
      'band',
      'venue',
      'promoter',
      'collective',
      'business',
      'other',
    ]);
    expect(LEAD_STAGES).toEqual([
      'to_contact',
      'contacted',
      'in_talks',
      'on_board',
      'not_now',
    ]);
    expect(OPEN_LEAD_STAGES).toEqual(['to_contact', 'contacted', 'in_talks']);
    expect(LEAD_ENTRY_KINDS).toEqual([
      'note',
      'stage_changed',
      'persona_linked',
      'persona_unlinked',
      'created',
    ]);
    expect([
      LEAD_NAME_MAX,
      LEAD_LOCATION_MAX,
      LEAD_EMAIL_MAX,
      LEAD_PHONE_MAX,
      LEAD_LINKS_MAX,
      LEAD_LINK_MAX,
      LEAD_NOTE_MAX,
      LEAD_PAGE_SIZE,
      LEAD_PERSONA_SEARCH_LIMIT,
      LEAD_SEARCH_QUERY_MAX,
      LEAD_LIST_LINKS_SHOWN,
    ]).toEqual([120, 120, 254, 40, 12, 500, 4000, 50, 20, 100, 3]);
    expect([
      DEFAULT_LEAD_STAGE,
      LEAD_TIME_ZONE,
      LEAD_FOLLOW_UP_MIN,
      LEAD_FOLLOW_UP_MAX,
    ]).toEqual(['to_contact', 'Europe/Lisbon', '2000-01-01', '2100-12-31']);
  });
});
