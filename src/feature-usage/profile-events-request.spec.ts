import { isProfileEventsRequest } from './profile-events-request';

describe('isProfileEventsRequest', () => {
  it.each([
    '/profiles/sam/events',
    '/v1/profiles/sam/events',
    '/v1/profiles/sam/events/',
    '/v1/profiles/sam/events?ignored=1',
  ])('recognises %s', (url) => {
    expect(isProfileEventsRequest(url)).toBe(true);
  });

  it.each([
    '/v1/events',
    '/v1/profiles/sam',
    '/v1/profiles/sam/mutuals',
    '/v1/profiles/sam/events/extra',
    '/v1/members/sam/events',
    '',
    undefined,
  ])('leaves %s alone', (url) => {
    expect(isProfileEventsRequest(url)).toBe(false);
  });
});
