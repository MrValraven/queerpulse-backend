import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { BlockFilterService } from '../social/block-filter.service';
import {
  Subprofile,
  SubprofileLinkVisibility,
  SubprofileStatus,
  SubprofileVisibility,
} from './entities/subprofile.entity';
import { SubprofileFollower } from './entities/subprofile-follower.entity';
import { SubprofileFollowersService } from './subprofile-followers.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SUBPROFILE_FOLLOWED } from './subprofile.events';

const PERSONA_ID = 'sp-1';
const CREATOR_ID = 'creator-1';
const CO_OWNER_ID = 'co-owner-1';
const VISITOR_ID = 'visitor-1';

// The followable persona `resolveFollowablePersona` loads: published, open and
// live (`removedAt` null). Only the fields the follow path reads.
function makePersona(overrides: Partial<Subprofile> = {}): Subprofile {
  return {
    id: PERSONA_ID,
    userId: CREATOR_ID,
    slug: 'nightform',
    status: SubprofileStatus.Published,
    visibility: SubprofileVisibility.Open,
    linkVisibility: SubprofileLinkVisibility.Linked,
    removedAt: null,
    ...overrides,
  } as Subprofile;
}

describe('SubprofileFollowersService.follow', () => {
  let service: SubprofileFollowersService;
  // The follow insert runs in `followers.manager.transaction`, on the
  // transaction's own manager, after a locked re-read of the persona.
  let transactionManager: { findOne: jest.Mock; insert: jest.Mock };
  let followers: { manager: { transaction: jest.Mock } };
  let subprofiles: { findOne: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let membership: { isMember: jest.Mock };

  beforeEach(() => {
    transactionManager = {
      findOne: jest.fn().mockResolvedValue(makePersona()),
      insert: jest.fn().mockResolvedValue(undefined),
    };
    followers = {
      manager: {
        transaction: jest.fn(
          (work: (manager: typeof transactionManager) => Promise<unknown>) =>
            work(transactionManager),
        ),
      },
    };
    subprofiles = { findOne: jest.fn().mockResolvedValue(makePersona()) };
    blockFilter = { isBlockedEitherWay: jest.fn().mockResolvedValue(false) };
    eventEmitter = { emit: jest.fn() };
    contentModeration = {
      stateFor: jest.fn().mockResolvedValue({ hidden: false, removed: false }),
    };
    // Only the co-owner holds a roster row besides the creator.
    membership = {
      isMember: jest.fn((userId: string, subprofileId: string) =>
        Promise.resolve(
          subprofileId === PERSONA_ID &&
            (userId === CREATOR_ID || userId === CO_OWNER_ID),
        ),
      ),
    };
    service = new SubprofileFollowersService(
      followers as never,
      subprofiles as never,
      {} as never,
      {} as never,
      blockFilter as unknown as BlockFilterService,
      eventEmitter as unknown as EventEmitter2,
      contentModeration as unknown as ContentModerationService,
      membership as unknown as SubprofileMembershipService,
    );
    jest
      .spyOn(service, 'loadFollowerCountsFor')
      .mockResolvedValue(new Map([[PERSONA_ID, 1]]));
  });

  it('refuses the creator with the own-persona error', async () => {
    await expect(service.follow(CREATOR_ID, PERSONA_ID)).rejects.toThrow(
      new BadRequestException('You cannot follow your own persona'),
    );
    expect(transactionManager.insert).not.toHaveBeenCalled();
  });

  it('refuses a co-owner with the same error the creator gets', async () => {
    await expect(service.follow(CO_OWNER_ID, PERSONA_ID)).rejects.toThrow(
      new BadRequestException('You cannot follow your own persona'),
    );
    expect(membership.isMember).toHaveBeenCalledWith(CO_OWNER_ID, PERSONA_ID);
    expect(transactionManager.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('lets a member who owns no seat on the persona follow it', async () => {
    const result = await service.follow(VISITOR_ID, PERSONA_ID);

    expect(result).toEqual({ followerCount: 1, viewerFollowing: true });
    expect(transactionManager.findOne).toHaveBeenCalledWith(Subprofile, {
      where: { id: PERSONA_ID },
      lock: { mode: 'pessimistic_read' },
    });
    expect(transactionManager.insert).toHaveBeenCalledWith(SubprofileFollower, {
      subprofileId: PERSONA_ID,
      followerId: VISITOR_ID,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SUBPROFILE_FOLLOWED,
      expect.objectContaining({ subprofileId: PERSONA_ID }),
    );
  });

  // Task 3 review Minor 1: a linked-to-unlinked switch that commits between
  // the resolve and the insert has deleted every follower, so the locked
  // re-read sees the new link state and refuses the insert.
  it('refuses the insert when the persona switched link state meanwhile', async () => {
    transactionManager.findOne.mockResolvedValue(
      makePersona({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Draft,
      }),
    );

    await expect(service.follow(VISITOR_ID, PERSONA_ID)).rejects.toThrow(
      new NotFoundException('Subprofile not found'),
    );
    expect(transactionManager.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('treats a lost insert race for the same pair as idempotent success, with no event', async () => {
    transactionManager.insert.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(service.follow(VISITOR_ID, PERSONA_ID)).resolves.toEqual({
      followerCount: 1,
      viewerFollowing: true,
    });
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('reads the takedown under the persona uuid and 404s a taken-down persona', async () => {
    contentModeration.stateFor.mockImplementation(
      (subjectType: string, subjectId: string) =>
        Promise.resolve({
          hidden: subjectType === 'subprofile' && subjectId === PERSONA_ID,
          removed: false,
        }),
    );

    await expect(service.follow(VISITOR_ID, PERSONA_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(contentModeration.stateFor).toHaveBeenCalledWith(
      'subprofile',
      PERSONA_ID,
    );
    expect(transactionManager.insert).not.toHaveBeenCalled();
  });

  it('ignores a slug-keyed row, which may belong to a persona of the same slug', async () => {
    contentModeration.stateFor.mockImplementation(
      (subjectType: string, subjectId: string) =>
        Promise.resolve({
          hidden: subjectType === 'subprofile' && subjectId === 'nightform',
          removed: false,
        }),
    );

    await expect(service.follow(VISITOR_ID, PERSONA_ID)).resolves.toEqual({
      followerCount: 1,
      viewerFollowing: true,
    });
  });
});
