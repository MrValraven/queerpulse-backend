import { Logger } from '@nestjs/common';
import { AccessTier } from '../communities/entities/community.entity';
import { CommunityBadgeTriggersListener } from './community-badge-triggers.listener';

describe('CommunityBadgeTriggersListener', () => {
  let listener: CommunityBadgeTriggersListener;
  let awarding: { evaluateMember: jest.Mock };
  let dataSource: { query: jest.Mock };

  const postEvent = (overrides: Record<string, unknown> = {}) => ({
    authorId: 'u1',
    communitySlug: 'night-swim',
    communityName: 'Night Swim',
    accessTier: AccessTier.Public,
    postId: 'p1',
    excerpt: 'hello',
    ...overrides,
  });
  const replyEvent = (overrides: Record<string, unknown> = {}) => ({
    communityId: 'c1',
    authorId: 'u1',
    postId: 'p1',
    replyId: 'r1',
    ...overrides,
  });
  const checkInEvent = (overrides: Record<string, unknown> = {}) => ({
    eventId: 'e1',
    communityId: 'c1',
    userId: 'u1',
    ...overrides,
  });
  const volunteerEvent = (overrides: Record<string, unknown> = {}) => ({
    signupId: 's1',
    opportunityId: 'o1',
    opportunitySlug: 'beach-cleanup',
    volunteerId: 'u1',
    confirmedById: 'u2',
    attended: true,
    hoursContributed: 2,
    completedAt: '2026-11-22T10:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    awarding = { evaluateMember: jest.fn().mockResolvedValue(0) };
    dataSource = { query: jest.fn() };
    listener = new CommunityBadgeTriggersListener(
      awarding as never,
      dataSource as never,
    );
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('notifies on a post through the community resolved by slug', async () => {
    dataSource.query.mockResolvedValue([{ id: 'c1' }]);
    await listener.onPostCreated(
      postEvent({ communitySlug: 'night-swim', authorId: 'u1' }),
    );
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "communities" WHERE "slug" = $1'),
      ['night-swim'],
    );
    expect(awarding.evaluateMember).toHaveBeenCalledWith({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
  });

  it('evaluates nothing for a post whose slug resolves to no community', async () => {
    dataSource.query.mockResolvedValue([]);
    await listener.onPostCreated(postEvent());
    expect(awarding.evaluateMember).not.toHaveBeenCalled();
  });

  it('notifies on a reply', async () => {
    await listener.onReplyCreated(replyEvent());
    expect(awarding.evaluateMember).toHaveBeenCalledWith({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
  });

  it('notifies on a check-in at a community event', async () => {
    await listener.onAttendeeCheckedIn(checkInEvent());
    expect(awarding.evaluateMember).toHaveBeenCalledWith({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
  });

  it('ignores a check-in at an event with no community', async () => {
    await listener.onAttendeeCheckedIn(checkInEvent({ communityId: null }));
    expect(awarding.evaluateMember).not.toHaveBeenCalled();
  });

  it('notifies the volunteer through the opportunity community', async () => {
    dataSource.query.mockResolvedValue([{ community_id: 'c1' }]);
    await listener.onVolunteerSessionCompleted(volunteerEvent());
    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM "volunteer_opportunities" WHERE "id" = $1'),
      ['o1'],
    );
    expect(awarding.evaluateMember).toHaveBeenCalledWith({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: true,
    });
  });

  it('ignores a no-show volunteer session', async () => {
    await listener.onVolunteerSessionCompleted(
      volunteerEvent({ attended: false }),
    );
    expect(dataSource.query).not.toHaveBeenCalled();
    expect(awarding.evaluateMember).not.toHaveBeenCalled();
  });

  it('ignores a volunteer session on an opportunity with no community', async () => {
    dataSource.query.mockResolvedValue([{ community_id: null }]);
    await listener.onVolunteerSessionCompleted(volunteerEvent());
    expect(awarding.evaluateMember).not.toHaveBeenCalled();
  });

  it('evaluates a joining member silently', async () => {
    await listener.onMemberJoined({ communityId: 'c1', userId: 'u1' });
    expect(awarding.evaluateMember).toHaveBeenCalledWith({
      communityId: 'c1',
      userId: 'u1',
      shouldNotify: false,
    });
  });

  it('swallows an evaluation failure', async () => {
    awarding.evaluateMember.mockRejectedValue(new Error('db down'));
    await expect(
      listener.onReplyCreated(replyEvent() as never),
    ).resolves.toBeUndefined();
  });

  it('swallows a lookup failure on a post', async () => {
    dataSource.query.mockRejectedValue(new Error('db down'));
    await expect(
      listener.onPostCreated(postEvent() as never),
    ).resolves.toBeUndefined();
    expect(awarding.evaluateMember).not.toHaveBeenCalled();
  });

  it('logs the error class only', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn');
    awarding.evaluateMember.mockRejectedValue(new TypeError('secret detail'));
    await listener.onMemberJoined({ communityId: 'c1', userId: 'u1' });
    expect(warnSpy).toHaveBeenCalledWith(
      'Community badge evaluation failed for subject c1: TypeError',
    );
  });
});
