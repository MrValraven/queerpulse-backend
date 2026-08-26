import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { EventVisibility } from '../events/entities/event.entity';
import {
  Subprofile,
  SubprofileLinkVisibility,
} from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { ActivityListener } from './activity.listener';
import { ActivityService, RecordActivityInput } from './activity.service';
import {
  Activity,
  ActivityKind,
  ActivitySubjectKind,
} from './entities/activity.entity';

interface Harness {
  listener: ActivityListener;
  record: jest.Mock;
  activities: { delete: jest.Mock };
  communities: { findOne: jest.Mock };
  subprofiles: { findOne: jest.Mock };
  profiles: { findOne: jest.Mock };
}

async function buildListener(): Promise<Harness> {
  const record = jest.fn().mockResolvedValue(undefined);
  const activities = { delete: jest.fn().mockResolvedValue({}) };
  const communities = { findOne: jest.fn().mockResolvedValue(null) };
  const subprofiles = { findOne: jest.fn().mockResolvedValue(null) };
  const profiles = { findOne: jest.fn().mockResolvedValue(null) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ActivityListener,
      { provide: ActivityService, useValue: { record } },
      { provide: getRepositoryToken(Activity), useValue: activities },
      { provide: getRepositoryToken(Community), useValue: communities },
      { provide: getRepositoryToken(Subprofile), useValue: subprofiles },
      { provide: getRepositoryToken(Profile), useValue: profiles },
    ],
  }).compile();
  return {
    listener: module.get(ActivityListener),
    record,
    activities,
    communities,
    subprofiles,
    profiles,
  };
}

/** The single row this listener recorded, failing loudly when it recorded none. */
const recorded = (record: jest.Mock): RecordActivityInput => {
  const calls = record.mock.calls as unknown as Array<[RecordActivityInput]>;
  const firstCall = calls[0];
  if (!firstCall) {
    throw new Error('expected an activity row to be recorded, none was');
  }
  return firstCall[0];
};

describe('ActivityListener write gate: events', () => {
  const rsvp = (visibility: EventVisibility) => ({
    eventId: 'event-id',
    eventSlug: 'poetry-night',
    hostId: 'host-1',
    rsvperId: 'member-1',
    eventTitle: 'Queer Poetry Night',
    eventVisibility: visibility,
  });

  it('records a public gathering RSVP with a link and its subject', async () => {
    const { listener, record } = await buildListener();
    await listener.onEventRsvped(rsvp(EventVisibility.Public));

    expect(recorded(record)).toMatchObject({
      userId: 'member-1',
      kind: ActivityKind.Event,
      toLink: '/gatherings/poetry-night',
      subjectKind: ActivitySubjectKind.Event,
      subjectId: 'poetry-night',
    });
  });

  it.each([
    EventVisibility.Members,
    EventVisibility.InviteOnly,
    EventVisibility.ExtendedNetwork,
    EventVisibility.Community,
  ])('records nothing for a %s gathering', async (visibility) => {
    const { listener, record } = await buildListener();
    await listener.onEventRsvped(rsvp(visibility));

    // Attending a non-public gathering is not a public fact, and the
    // gathering's very existence could out the member.
    expect(record).not.toHaveBeenCalled();
  });
});

describe('ActivityListener write gate: communities', () => {
  const post = (accessTier: AccessTier) => ({
    authorId: 'member-1',
    communitySlug: 'trans-joy',
    communityName: 'Trans Joy',
    accessTier,
    postId: 'post-9',
    excerpt: 'hello',
  });

  it('links a public-community post at its permalink', async () => {
    const { listener, record } = await buildListener();
    await listener.onCommunityPostCreated(post(AccessTier.Public));

    expect(recorded(record)).toMatchObject({
      toLink: '/community/trans-joy/post/post-9',
      // The COMMUNITY is what gets re-checked, not the post: a post's
      // readability is entirely a function of its community's access tier.
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'trans-joy',
    });
  });

  it.each([AccessTier.Request, AccessTier.Invite, AccessTier.Private])(
    'records nothing for a post in a %s community',
    async (accessTier) => {
      const { listener, record } = await buildListener();
      await listener.onCommunityPostCreated(post(accessTier));

      expect(record).not.toHaveBeenCalled();
    },
  );

  it('records a join only when the community is public and unarchived', async () => {
    const { listener, record, communities } = await buildListener();
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'trans-joy',
      name: 'Trans Joy',
      accessTier: AccessTier.Public,
      archivedAt: null,
    });

    await listener.onCommunityMemberJoined({
      communityId: 'community-1',
      userId: 'member-1',
    });

    expect(recorded(record)).toMatchObject({
      kind: ActivityKind.Community,
      title: 'Joined Trans Joy',
      toLink: '/community/trans-joy',
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'trans-joy',
    });
  });

  it.each([AccessTier.Request, AccessTier.Invite, AccessTier.Private])(
    'records nothing when joining a %s community',
    async (accessTier) => {
      const { listener, record, communities } = await buildListener();
      communities.findOne.mockResolvedValue({
        id: 'community-1',
        slug: 'closed-room',
        name: 'Closed Room',
        accessTier,
        archivedAt: null,
      });

      await listener.onCommunityMemberJoined({
        communityId: 'community-1',
        userId: 'member-1',
      });

      // Being IN a private space is exactly the fact a private space exists to
      // keep. This is the single most important assertion on this listener.
      expect(record).not.toHaveBeenCalled();
    },
  );

  it('records nothing when joining an archived community', async () => {
    const { listener, record, communities } = await buildListener();
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'gone',
      name: 'Gone',
      accessTier: AccessTier.Public,
      archivedAt: new Date(),
    });

    await listener.onCommunityMemberJoined({
      communityId: 'community-1',
      userId: 'member-1',
    });

    expect(record).not.toHaveBeenCalled();
  });

  it('retracts the join row when the member leaves', async () => {
    const { listener, activities, communities } = await buildListener();
    communities.findOne.mockResolvedValue({
      id: 'community-1',
      slug: 'trans-joy',
    });

    await listener.onCommunityMemberLeft({
      communityId: 'community-1',
      userId: 'member-1',
    });

    // "Joined X" is false the moment the member is off the roster, and the
    // community may well still be public, so the read-time gate would never
    // drop it.
    expect(activities.delete).toHaveBeenCalledWith({
      userId: 'member-1',
      kind: ActivityKind.Community,
      subjectKind: ActivitySubjectKind.Community,
      subjectId: 'trans-joy',
    });
  });
});

describe('ActivityListener write gate: personas', () => {
  it('records a linked, published, open persona', async () => {
    const { listener, record, subprofiles, profiles } = await buildListener();
    subprofiles.findOne.mockResolvedValue({
      id: 'persona-1',
      userId: 'member-1',
      slug: 'dj-set',
      displayName: 'DJ Set',
      linkVisibility: SubprofileLinkVisibility.Linked,
    });
    profiles.findOne.mockResolvedValue({ slug: 'ana' });

    await listener.onSubprofilePublished({
      subprofileId: 'persona-1',
      ownerUserId: 'member-1',
    });

    expect(recorded(record)).toMatchObject({
      kind: ActivityKind.Persona,
      toLink: '/members/ana/dj-set',
      subjectKind: ActivitySubjectKind.Persona,
      subjectId: 'persona-1',
    });
  });

  it('records nothing when the persona is not published+open', async () => {
    const { listener, record, subprofiles } = await buildListener();
    // The lookup itself filters on published + open + not-removed, so a draft
    // or a network/private persona simply is not found.
    subprofiles.findOne.mockResolvedValue(null);

    await listener.onSubprofilePublished({
      subprofileId: 'persona-1',
      ownerUserId: 'member-1',
    });

    expect(record).not.toHaveBeenCalled();
  });

  it('records nothing for an UNLINKED persona', async () => {
    const { listener, record, subprofiles } = await buildListener();
    subprofiles.findOne.mockResolvedValue({
      id: 'persona-1',
      userId: 'member-1',
      slug: 'night-work',
      displayName: 'Night Work',
      linkVisibility: SubprofileLinkVisibility.Unlinked,
      handle: 'nightwork',
    });

    await listener.onSubprofilePublished({
      subprofileId: 'persona-1',
      ownerUserId: 'member-1',
    });

    // Unlinked means the persona is deliberately not tied back to the member.
    // A row on the member's own profile announcing it would undo that with
    // the member's own byline.
    expect(record).not.toHaveBeenCalled();
  });
});
