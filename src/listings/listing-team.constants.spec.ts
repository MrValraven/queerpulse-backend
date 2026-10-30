import { HttpStatus, NotFoundException } from '@nestjs/common';
import {
  LISTING_TEAM_ERRORS,
  LISTING_TEAM_LIMITS,
  ListingTeamErrorCode,
  listingTeamError,
} from './listing-team.constants';

describe('listing team constants', () => {
  it('holds the limits the contract fixes', () => {
    expect(LISTING_TEAM_LIMITS).toEqual({
      acceptedPerListing: 40,
      pendingPerListing: 40,
      acceptedPerPersona: 10,
      acceptedPerMember: 10,
      pendingRequestsPerPersona: 10,
      cooldownDays: 14,
      roleLabelMax: 40,
    });
  });

  const expectedStatuses: Array<[ListingTeamErrorCode, number]> = [
    ['listing_team_persona_not_found', 404],
    ['listing_team_listing_not_found', 404],
    ['listing_team_link_not_found', 404],
    ['listing_team_persona_ineligible', 422],
    ['listing_team_listing_not_live', 409],
    ['listing_team_already_pending', 409],
    ['listing_team_already_accepted', 409],
    ['listing_team_cooldown', 409],
    ['listing_team_full', 409],
    ['listing_team_pending_full', 409],
    ['listing_team_persona_full', 409],
    ['listing_team_persona_requests_full', 409],
    ['listing_team_member_not_found', 404],
    ['listing_team_member_ineligible', 422],
    ['listing_team_member_full', 409],
    ['listing_team_not_pending', 409],
    ['listing_team_not_accepted', 409],
    ['listing_team_order_mismatch', 409],
  ];

  it.each(expectedStatuses)('answers %s with status %i', (code, status) => {
    const error = listingTeamError(code);
    expect(error.getStatus()).toBe(status);
    expect(error.getResponse()).toEqual({
      statusCode: status,
      code,
      message: expect.any(String),
    });
  });

  it('answers a 404 code as a NotFoundException', () => {
    expect(listingTeamError('listing_team_link_not_found')).toBeInstanceOf(
      NotFoundException,
    );
    expect(LISTING_TEAM_ERRORS.listing_team_full.status).toBe(
      HttpStatus.CONFLICT,
    );
  });

  it('adds details and keeps the code and status over a detail of the same name', () => {
    expect(
      listingTeamError('listing_team_cooldown', {
        retryAt: '2026-11-02T10:00:00.000Z',
        code: 'other',
        statusCode: 200,
      }).getResponse(),
    ).toEqual({
      statusCode: 409,
      code: 'listing_team_cooldown',
      message: expect.any(String),
      retryAt: '2026-11-02T10:00:00.000Z',
    });
  });

  it('names the real cause in each member message', () => {
    expect(LISTING_TEAM_ERRORS.listing_team_member_not_found.message).toMatch(
      /connections/i,
    );
    expect(LISTING_TEAM_ERRORS.listing_team_member_ineligible.message).toMatch(
      /open and visible/i,
    );
    expect(LISTING_TEAM_ERRORS.listing_team_member_full.message).toMatch(
      /10 teams/,
    );
    expect(listingTeamError('listing_team_member_not_found')).toBeInstanceOf(
      NotFoundException,
    );
  });

  it('words the two shared team messages for a persona and a member alike', () => {
    expect(LISTING_TEAM_ERRORS.listing_team_already_accepted.message).toBe(
      'This person is already on the team.',
    );
    expect(LISTING_TEAM_ERRORS.listing_team_not_accepted.message).toBe(
      'This person is not on the team.',
    );
    expect(LISTING_TEAM_ERRORS.listing_team_member_ineligible.message).toMatch(
      /before they can be on a team/,
    );
  });

  it('never says blocked in any message', () => {
    for (const { message } of Object.values(LISTING_TEAM_ERRORS)) {
      expect(message).not.toMatch(/block/i);
    }
  });
});
