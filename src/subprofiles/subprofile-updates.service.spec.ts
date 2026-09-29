import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { SubprofileSection } from './entities/subprofile-item.entity';
import {
  Subprofile,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileUpdatesService } from './subprofile-updates.service';

const PERSONA_ID = 'sp-1';
const PERSONA_SLUG = 'nightform';
const CREATOR_ID = 'creator-1';
const FOLLOWER_ID = 'follower-1';

// The published, open, live persona `notifyFollowersOfNewItems` fans a
// notification out for. Only the fields the fan-out reads.
function makePersona(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: PERSONA_ID,
    userId: CREATOR_ID,
    slug: PERSONA_SLUG,
    displayName: 'Nightform',
    handle: 'nightform',
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    removedAt: null,
    ...overrides,
  } as Subprofile;
}

describe('SubprofileUpdatesService.notifyFollowersOfNewItems', () => {
  let service: SubprofileUpdatesService;
  let followers: { find: jest.Mock };
  let members: { find: jest.Mock };
  let profiles: { findOne: jest.Mock };
  let notifications: { createForRecipients: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };

  beforeEach(() => {
    followers = {
      find: jest.fn().mockResolvedValue([{ followerId: FOLLOWER_ID }]),
    };
    members = { find: jest.fn().mockResolvedValue([]) };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };
    notifications = {
      createForRecipients: jest.fn().mockResolvedValue([FOLLOWER_ID]),
    };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    service = new SubprofileUpdatesService(
      {} as never,
      followers as never,
      members as never,
      profiles as never,
      notifications as unknown as NotificationsService,
      contentModeration as unknown as ContentModerationService,
    );
  });

  it('sends nothing and never looks up followers when the persona is under a takedown', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: true,
      removed: false,
    });

    await service.notifyFollowersOfNewItems(
      makePersona(),
      ['Existing item'],
      ['Existing item', 'New item'],
      SubprofileSection.Projects,
    );

    expect(followers.find).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('withholds a removed persona too', async () => {
    contentModeration.stateFor.mockResolvedValue({
      hidden: false,
      removed: true,
    });

    await service.notifyFollowersOfNewItems(
      makePersona(),
      ['Existing item'],
      ['Existing item', 'New item'],
      SubprofileSection.Projects,
    );

    expect(followers.find).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });

  it('notifies followers as before when there is no takedown', async () => {
    await service.notifyFollowersOfNewItems(
      makePersona(),
      ['Existing item'],
      ['Existing item', 'New item'],
      SubprofileSection.Projects,
    );

    expect(followers.find).toHaveBeenCalled();
    expect(notifications.createForRecipients).toHaveBeenCalledWith(
      [FOLLOWER_ID],
      NotificationType.PersonaUpdate,
      expect.objectContaining({
        subprofileId: PERSONA_ID,
        newItemCount: 1,
      }),
      CREATOR_ID,
    );
  });

  it('reads the takedown under the persona uuid', async () => {
    await service.notifyFollowersOfNewItems(
      makePersona(),
      ['Existing item'],
      ['Existing item', 'New item'],
      SubprofileSection.Projects,
    );

    expect(contentModeration.stateFor).toHaveBeenCalledWith(
      'subprofile',
      PERSONA_ID,
    );
    expect(contentModeration.stateFor).not.toHaveBeenCalledWith(
      'subprofile',
      PERSONA_SLUG,
    );
  });

  it('never checks for a takedown when the save added no items (short-circuits first)', async () => {
    await service.notifyFollowersOfNewItems(
      makePersona(),
      ['Same item'],
      ['Same item'],
      SubprofileSection.Projects,
    );

    expect(contentModeration.stateFor).not.toHaveBeenCalled();
    expect(followers.find).not.toHaveBeenCalled();
    expect(notifications.createForRecipients).not.toHaveBeenCalled();
  });
});
