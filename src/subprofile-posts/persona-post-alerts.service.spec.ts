import { Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { SubprofileFollower } from '../subprofiles/entities/subprofile-follower.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { SubprofilePost } from './entities/subprofile-post.entity';
import { PersonaPostAlertsService } from './persona-post-alerts.service';

const OWNER_ID = 'df000000-0000-4000-8000-000000000001';
const CO_OWNER_ID = 'df000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'df000000-0000-4000-8000-000000000003';
const POST_ID = 'df000000-0000-4000-8000-000000000004';

const followerIds = (count: number): string[] =>
  Array.from(
    { length: count },
    (_unused, index) =>
      `df100000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  );

describe('PersonaPostAlertsService', () => {
  let persona: Subprofile;
  let post: SubprofilePost;
  let followers: { find: jest.Mock };
  let members: { find: jest.Mock };
  let createForRecipients: jest.Mock;
  let contentModeration: { stateFor: jest.Mock };
  let service: PersonaPostAlertsService;

  beforeEach(() => {
    persona = {
      id: PERSONA_ID,
      userId: OWNER_ID,
      slug: 'night-shift-slug',
      handle: 'night-shift',
      displayName: 'Night Shift',
      status: SubprofileStatus.Published,
      visibility: SubprofileVisibility.Open,
      removedAt: null,
    } as Subprofile;
    post = {
      id: POST_ID,
      authorUserId: CO_OWNER_ID,
      body: 'New single out Friday, release party at Lux',
    } as SubprofilePost;
    followers = {
      find: jest.fn().mockResolvedValue(
        [...followerIds(2), CO_OWNER_ID, OWNER_ID].map((followerId) => ({
          followerId,
        })),
      ),
    };
    members = {
      find: jest.fn().mockResolvedValue([{ userId: CO_OWNER_ID }]),
    };
    createForRecipients = jest.fn().mockResolvedValue([]);
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    service = new PersonaPostAlertsService(
      followers as unknown as Repository<SubprofileFollower>,
      members as unknown as Repository<SubprofileMember>,
      { createForRecipients } as unknown as NotificationsService,
      contentModeration as unknown as ContentModerationService,
    );
  });

  it('tells the followers minus the persona owner and the co-owners, under the owner id for block and mute', async () => {
    await service.alertFollowers(persona, post);

    expect(followers.find).toHaveBeenCalledWith({
      where: { subprofileId: PERSONA_ID },
      select: { followerId: true },
      order: { createdAt: 'ASC', id: 'ASC' },
      take: 5000,
    });
    expect(createForRecipients).toHaveBeenCalledTimes(1);
    const [recipientIds, type, , actorId] = createForRecipients.mock
      .calls[0] as [string[], NotificationType, object, string];
    expect(recipientIds).toEqual(followerIds(2));
    expect(recipientIds).not.toContain(OWNER_ID);
    expect(recipientIds).not.toContain(CO_OWNER_ID);
    expect(type).toBe(NotificationType.PersonaPost);
    expect(actorId).toBe(OWNER_ID);
  });

  it('puts the persona and the post on the payload and no member id', async () => {
    await service.alertFollowers(persona, post);

    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload).toEqual({
      subprofileName: 'Night Shift',
      subprofileSlugOrHandle: 'night-shift',
      subprofileId: PERSONA_ID,
      postId: POST_ID,
      excerpt: 'New single out Friday, release party at Lux',
    });
    expect(JSON.stringify(payload)).not.toContain(OWNER_ID);
    expect(JSON.stringify(payload)).not.toContain(CO_OWNER_ID);
  });

  it('fans out in chunks of 500', async () => {
    followers.find.mockResolvedValue(
      followerIds(1200).map((followerId) => ({ followerId })),
    );
    members.find.mockResolvedValue([]);

    await service.alertFollowers(persona, post);

    expect(
      createForRecipients.mock.calls.map(
        ([recipientIds]) => (recipientIds as string[]).length,
      ),
    ).toEqual([500, 500, 200]);
  });

  it('keeps at most three chunks in flight', async () => {
    followers.find.mockResolvedValue(
      followerIds(3200).map((followerId) => ({ followerId })),
    );
    members.find.mockResolvedValue([]);
    let chunksInFlight = 0;
    let mostChunksInFlight = 0;
    createForRecipients.mockImplementation(async () => {
      chunksInFlight += 1;
      mostChunksInFlight = Math.max(mostChunksInFlight, chunksInFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      chunksInFlight -= 1;
      return [];
    });

    await service.alertFollowers(persona, post);

    expect(createForRecipients).toHaveBeenCalledTimes(7);
    expect(mostChunksInFlight).toBe(3);
  });

  it.each([
    [
      'a draft',
      (target: Subprofile) => (target.status = SubprofileStatus.Draft),
    ],
    [
      'a network persona',
      (target: Subprofile) =>
        (target.visibility = SubprofileVisibility.Network),
    ],
    [
      'a removed persona',
      (target: Subprofile) => (target.removedAt = new Date()),
    ],
  ])(
    'sends nothing for a persona that is not live: %s',
    async (_label, arrange) => {
      arrange(persona);
      await service.alertFollowers(persona, post);
      expect(followers.find).not.toHaveBeenCalled();
      expect(createForRecipients).not.toHaveBeenCalled();
    },
  );

  it('sends nothing for a persona under a takedown', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: false,
      removed: true,
    });
    await service.alertFollowers(persona, post);
    expect(createForRecipients).not.toHaveBeenCalled();
  });

  it('names a persona with a blank display name by its link token', async () => {
    persona.displayName = '  ';
    persona.handle = null;
    await service.alertFollowers(persona, post);
    const payload = createForRecipients.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(payload.subprofileName).toBe('night-shift-slug');
    expect(payload.subprofileSlugOrHandle).toBe('night-shift-slug');
  });

  it('never throws back at the post', async () => {
    createForRecipients.mockRejectedValue(new Error('pool exhausted'));
    await expect(
      service.alertFollowers(persona, post),
    ).resolves.toBeUndefined();
  });
});
