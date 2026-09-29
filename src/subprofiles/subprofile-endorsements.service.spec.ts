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
import { SubprofileEndorsement } from './entities/subprofile-endorsement.entity';
import { SubprofileEndorsementsService } from './subprofile-endorsements.service';
import { SubprofileMembershipService } from './subprofile-membership.service';
import { SUBPROFILE_ENDORSED } from './subprofile.events';

const PERSONA_ID = 'sp-1';
const CREATOR_ID = 'creator-1';
const CO_OWNER_ID = 'co-owner-1';
const VISITOR_ID = 'visitor-1';

// The endorsable persona `resolveEndorsablePersona` loads: published, open and
// live (`removedAt` null). Only the fields the endorse path reads.
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

describe('SubprofileEndorsementsService.endorse', () => {
  let service: SubprofileEndorsementsService;
  // The endorse write runs in `endorsements.manager.transaction`, after a
  // locked re-read of the persona; the transaction's endorsement repository is
  // this same mock, so the row assertions below read it directly.
  let transactionManager: { findOne: jest.Mock; getRepository: jest.Mock };
  let endorsements: {
    findOne: jest.Mock;
    insert: jest.Mock;
    update: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let subprofiles: { findOne: jest.Mock };
  let blockFilter: { isBlockedEitherWay: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let contentModeration: { stateFor: jest.Mock };
  let membership: { isMember: jest.Mock };

  beforeEach(() => {
    transactionManager = {
      findOne: jest.fn().mockResolvedValue(makePersona()),
      getRepository: jest.fn(),
    };
    endorsements = {
      findOne: jest.fn().mockResolvedValue(null),
      insert: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      manager: {
        transaction: jest.fn(
          (work: (manager: typeof transactionManager) => Promise<unknown>) =>
            work(transactionManager),
        ),
      },
    };
    transactionManager.getRepository.mockImplementation((entity: unknown) =>
      entity === SubprofileEndorsement ? endorsements : undefined,
    );
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
    service = new SubprofileEndorsementsService(
      endorsements as never,
      subprofiles as never,
      {} as never,
      {} as never,
      blockFilter as unknown as BlockFilterService,
      eventEmitter as unknown as EventEmitter2,
      contentModeration as unknown as ContentModerationService,
      membership as unknown as SubprofileMembershipService,
    );
    jest
      .spyOn(service, 'loadEndorsementCountsFor')
      .mockResolvedValue(new Map([[PERSONA_ID, 1]]));
  });

  it('refuses the creator with the own-persona error', async () => {
    await expect(service.endorse(CREATOR_ID, PERSONA_ID)).rejects.toThrow(
      new BadRequestException('You cannot endorse your own persona'),
    );
    expect(endorsements.insert).not.toHaveBeenCalled();
  });

  it('refuses a co-owner with the same error the creator gets', async () => {
    await expect(
      service.endorse(CO_OWNER_ID, PERSONA_ID, 'Brilliant sets'),
    ).rejects.toThrow(
      new BadRequestException('You cannot endorse your own persona'),
    );
    expect(membership.isMember).toHaveBeenCalledWith(CO_OWNER_ID, PERSONA_ID);
    expect(endorsements.findOne).not.toHaveBeenCalled();
    expect(endorsements.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('lets a member who owns no seat on the persona endorse it', async () => {
    const result = await service.endorse(VISITOR_ID, PERSONA_ID);

    expect(result).toEqual({ endorsementCount: 1, viewerEndorsed: true });
    expect(transactionManager.findOne).toHaveBeenCalledWith(Subprofile, {
      where: { id: PERSONA_ID },
      lock: { mode: 'pessimistic_read' },
    });
    expect(endorsements.insert).toHaveBeenCalledWith({
      subprofileId: PERSONA_ID,
      endorserId: VISITOR_ID,
      note: null,
    });
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      SUBPROFILE_ENDORSED,
      expect.objectContaining({ subprofileId: PERSONA_ID }),
    );
  });

  // Task 3 review Minor 1: a linked-to-unlinked switch that commits between
  // the resolve and the write has deleted every endorsement, so the locked
  // re-read sees the new link state and refuses the write.
  it('refuses the write when the persona switched link state meanwhile', async () => {
    transactionManager.findOne.mockResolvedValue(
      makePersona({
        linkVisibility: SubprofileLinkVisibility.Unlinked,
        status: SubprofileStatus.Draft,
      }),
    );

    await expect(service.endorse(VISITOR_ID, PERSONA_ID)).rejects.toThrow(
      new NotFoundException('Subprofile not found'),
    );
    expect(endorsements.findOne).not.toHaveBeenCalled();
    expect(endorsements.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('edits the note of an active endorsement without a new event', async () => {
    endorsements.findOne.mockResolvedValue({
      id: 'endorsement-1',
      withdrawnAt: null,
    });

    await service.endorse(VISITOR_ID, PERSONA_ID, '  Great sets  ');

    expect(endorsements.update).toHaveBeenCalledWith(
      { id: 'endorsement-1' },
      { note: 'Great sets' },
    );
    expect(endorsements.insert).not.toHaveBeenCalled();
    expect(eventEmitter.emit).not.toHaveBeenCalled();
  });

  it('treats a lost insert race for the same pair as idempotent success, with no event', async () => {
    endorsements.insert.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(service.endorse(VISITOR_ID, PERSONA_ID)).resolves.toEqual({
      endorsementCount: 1,
      viewerEndorsed: true,
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

    await expect(service.endorse(VISITOR_ID, PERSONA_ID)).rejects.toThrow(
      NotFoundException,
    );
    expect(contentModeration.stateFor).toHaveBeenCalledWith(
      'subprofile',
      PERSONA_ID,
    );
    expect(endorsements.insert).not.toHaveBeenCalled();
  });
});
