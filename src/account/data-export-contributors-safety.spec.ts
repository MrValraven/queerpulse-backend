import { Repository } from 'typeorm';
import {
  PolicyAcceptance,
  PolicyAcceptanceSource,
} from '../consent/entities/policy-acceptance.entity';
import {
  FlatmateProfile,
  FlatmateProfileType,
  IdentityVisibility,
} from '../flatmate-profiles/entities/flatmate-profile.entity';
import {
  GroupJoinRequest,
  GroupJoinRequestStatus,
} from '../housing-groups/entities/group-join-request.entity';
import {
  HousingViewing,
  HousingViewingMode,
  HousingViewingParty,
  HousingViewingStatus,
} from '../housing-viewings/entities/housing-viewing.entity';
import {
  CoopJoinRequest,
  JoinRequestStatus,
} from '../housing/entities/coop-join-request.entity';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Block } from '../social/entities/block.entity';
import {
  BlocksExportContributor,
  CoopJoinRequestsExportContributor,
  FlatmateProfileExportContributor,
  GroupJoinRequestsExportContributor,
  HousingViewingsExportContributor,
  PolicyAcceptancesExportContributor,
  ReportsFiledExportContributor,
} from './data-export-contributors-safety';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';

/** A repository stub exposing only the given finder methods. */
function repositoryWith<Entity extends object>(
  methods: Partial<Record<'find' | 'findOne', jest.Mock>>,
): Repository<Entity> {
  return methods as unknown as Repository<Entity>;
}

describe('ENG-495 contributor registration', () => {
  it('registers every new contributor in NEW_DOMAIN_EXPORT_CONTRIBUTORS', () => {
    expect(NEW_DOMAIN_EXPORT_CONTRIBUTORS).toEqual(
      expect.arrayContaining([
        FlatmateProfileExportContributor,
        HousingViewingsExportContributor,
        GroupJoinRequestsExportContributor,
        CoopJoinRequestsExportContributor,
        BlocksExportContributor,
        ReportsFiledExportContributor,
        PolicyAcceptancesExportContributor,
      ]),
    );
  });

  it('uses the category ids and archive keys the frontend builds against', () => {
    const pairs = [
      new FlatmateProfileExportContributor(repositoryWith({})),
      new HousingViewingsExportContributor(repositoryWith({})),
      new GroupJoinRequestsExportContributor(repositoryWith({})),
      new CoopJoinRequestsExportContributor(repositoryWith({})),
      new BlocksExportContributor(repositoryWith({}), repositoryWith({})),
      new ReportsFiledExportContributor(repositoryWith({})),
      new PolicyAcceptancesExportContributor(repositoryWith({})),
    ].map((contributor) => [contributor.category, contributor.archiveKey]);

    expect(pairs).toEqual([
      ['housing', 'flatmateProfile'],
      ['housing', 'viewings'],
      ['housing', 'groupJoinRequests'],
      ['housing', 'coopJoinRequests'],
      ['connections', 'blocks'],
      ['reports', 'reportsFiled'],
      ['consent', 'policyAcceptances'],
    ]);
  });
});

describe('FlatmateProfileExportContributor', () => {
  it('returns null for a member with no flatmate profile', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const contributor = new FlatmateProfileExportContributor(
      repositoryWith({ findOne }),
    );

    await expect(contributor.buildContribution('user-1')).resolves.toBeNull();
    expect(findOne).toHaveBeenCalledWith({ where: { ownerId: 'user-1' } });
  });

  it('exports every field, the special-category ones included', async () => {
    const profile = {
      id: 'flatmate-1',
      ownerId: 'user-1',
      slug: 'anika-seeking',
      type: FlatmateProfileType.Seeking,
      pronouns: 'she/they',
      neighbourhood: 'Arroios',
      budgetEuros: 650,
      moveInFrom: '2026-11-01',
      flexibleTiming: true,
      about: 'Quiet, plants, cooks on Sundays.',
      lifestyleTags: ['plants', 'early-riser'],
      genderIdentity: 'non-binary woman',
      safeSpaceNeeds: ['trans-inclusive-household'],
      householdNorms: { pets: 'ok' },
      identityHousehold: { mailNamePrivacy: 'chosen name please' },
      identityVisibility: IdentityVisibility.Matches,
      specialCategoryConsentAt: new Date('2026-02-01T10:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z'),
    } as FlatmateProfile;
    const contributor = new FlatmateProfileExportContributor(
      repositoryWith({ findOne: jest.fn().mockResolvedValue(profile) }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual({
      id: 'flatmate-1',
      slug: 'anika-seeking',
      type: FlatmateProfileType.Seeking,
      pronouns: 'she/they',
      neighbourhood: 'Arroios',
      budgetEuros: 650,
      moveInFrom: '2026-11-01',
      flexibleTiming: true,
      about: 'Quiet, plants, cooks on Sundays.',
      lifestyleTags: ['plants', 'early-riser'],
      genderIdentity: 'non-binary woman',
      safeSpaceNeeds: ['trans-inclusive-household'],
      householdNorms: { pets: 'ok' },
      identityHousehold: { mailNamePrivacy: 'chosen name please' },
      identityVisibility: IdentityVisibility.Matches,
      specialCategoryConsentAt: '2026-02-01T10:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    });
  });
});

describe('HousingViewingsExportContributor', () => {
  const viewingRow = (overrides: Partial<HousingViewing>): HousingViewing => ({
    id: 'viewing-1',
    listingId: 'listing-1',
    requesterId: 'user-1',
    listerId: 'lister-1',
    mode: HousingViewingMode.Video,
    status: HousingViewingStatus.Requested,
    proposedBy: HousingViewingParty.Requester,
    proposedSlots: [new Date('2026-04-01T18:00:00.000Z')],
    acceptedSlot: null,
    note: 'Could we do an evening call?',
    responseNote: null,
    createdAt: new Date('2026-03-20T00:00:00.000Z'),
    updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    ...overrides,
  });

  it('reads both sides of the member in one createdAt ASC query', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({ find }),
    );

    await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: [{ requesterId: 'user-1' }, { listerId: 'user-1' }],
      order: { createdAt: 'ASC' },
    });
  });

  it("gives a requester row the member's note and leaves out the lister's reply", async () => {
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          // The lister declined the member's request.
          viewingRow({
            status: HousingViewingStatus.Declined,
            responseNote: 'Room just went, sorry',
          }),
          // The lister counter-proposed.
          viewingRow({
            id: 'viewing-2',
            proposedBy: HousingViewingParty.Lister,
            responseNote: 'Could Thursday work instead?',
          }),
        ]),
      }),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows[0]).toEqual(
      expect.objectContaining({
        role: 'requester',
        note: 'Could we do an evening call?',
        responseNote: null,
        proposedSlots: ['2026-04-01T18:00:00.000Z'],
        acceptedSlot: null,
      }),
    );
    expect(rows[0]).not.toHaveProperty('requesterId');
    expect(rows[1]).toEqual(expect.objectContaining({ responseNote: null }));
  });

  it("keeps the requester's own reply note on a requester row", async () => {
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          // The member counter-proposed.
          viewingRow({
            proposedBy: HousingViewingParty.Requester,
            responseNote: 'Mornings are easier for me',
          }),
          // The member declined the lister's counter-proposal.
          viewingRow({
            id: 'viewing-2',
            status: HousingViewingStatus.Declined,
            proposedBy: HousingViewingParty.Lister,
            responseNote: 'Found somewhere else',
          }),
        ]),
      }),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => row.responseNote)).toEqual([
      'Mornings are easier for me',
      'Found somewhere else',
    ]);
  });

  it('names the requester by id alone on an owner row and leaves out their note', async () => {
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({
        find: jest
          .fn()
          .mockResolvedValue([
            viewingRow({ requesterId: 'requester-9', listerId: 'user-1' }),
          ]),
      }),
    );

    const [row] = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(row).toEqual(
      expect.objectContaining({ role: 'owner', requesterId: 'requester-9' }),
    );
    expect(row).not.toHaveProperty('note');
  });

  it("keeps the lister's own reply note on an owner row", async () => {
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          viewingRow({
            requesterId: 'requester-9',
            listerId: 'user-1',
            status: HousingViewingStatus.Declined,
            proposedBy: HousingViewingParty.Requester,
            responseNote: 'Already let, good luck',
          }),
          viewingRow({
            id: 'viewing-2',
            requesterId: 'requester-9',
            listerId: 'user-1',
            proposedBy: HousingViewingParty.Lister,
            responseNote: 'Could Thursday work instead?',
          }),
        ]),
      }),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => row.responseNote)).toEqual([
      'Already let, good luck',
      'Could Thursday work instead?',
    ]);
  });

  it('leaves out a reply note the requester wrote on an owner row', async () => {
    const contributor = new HousingViewingsExportContributor(
      repositoryWith({
        find: jest.fn().mockResolvedValue([
          // The requester declined the lister's counter-proposal.
          viewingRow({
            requesterId: 'requester-9',
            listerId: 'user-1',
            status: HousingViewingStatus.Declined,
            proposedBy: HousingViewingParty.Lister,
            responseNote: 'Found somewhere else',
          }),
          // The requester counter-proposed.
          viewingRow({
            id: 'viewing-2',
            requesterId: 'requester-9',
            listerId: 'user-1',
            proposedBy: HousingViewingParty.Requester,
            responseNote: 'Mornings are easier for me',
          }),
        ]),
      }),
    );

    const rows = (await contributor.buildContribution('user-1')) as Record<
      string,
      unknown
    >[];

    expect(rows.map((row) => row.responseNote)).toEqual([null, null]);
  });
});

describe('GroupJoinRequestsExportContributor', () => {
  it("exports the member's own requests with their answers", async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'request-1',
        groupId: 'group-1',
        name: 'Anika',
        relationship: 'Queer, organising in Lisbon for years',
        answers: [
          { questionId: 'q1', question: 'Why this group?', answer: 'Safety' },
        ],
        note: null,
        status: GroupJoinRequestStatus.Pending,
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      } as GroupJoinRequest,
    ]);
    const contributor = new GroupJoinRequestsExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'request-1',
        groupId: 'group-1',
        name: 'Anika',
        relationship: 'Queer, organising in Lisbon for years',
        answers: [
          { questionId: 'q1', question: 'Why this group?', answer: 'Safety' },
        ],
        note: null,
        status: GroupJoinRequestStatus.Pending,
        createdAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('CoopJoinRequestsExportContributor', () => {
  it("exports the member's own co-op requests", async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'coop-request-1',
        coopId: 'coop-1',
        name: 'Anika',
        householdSize: '2',
        note: 'We have a cat',
        status: JoinRequestStatus.Accepted,
        createdAt: new Date('2026-05-02T00:00:00.000Z'),
      } as CoopJoinRequest,
    ]);
    const contributor = new CoopJoinRequestsExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'coop-request-1',
        coopId: 'coop-1',
        name: 'Anika',
        householdSize: '2',
        note: 'We have a cat',
        status: JoinRequestStatus.Accepted,
        createdAt: '2026-05-02T00:00:00.000Z',
      },
    ]);
  });
});

describe('BlocksExportContributor', () => {
  it('reads only the blocks the member placed', async () => {
    const findMemberBlocks = jest.fn().mockResolvedValue([]);
    const findIdentityBlocks = jest.fn().mockResolvedValue([]);
    const contributor = new BlocksExportContributor(
      repositoryWith<Block>({ find: findMemberBlocks }),
      repositoryWith<IdentityBlock>({ find: findIdentityBlocks }),
    );

    await contributor.buildContribution('user-1');

    expect(findMemberBlocks).toHaveBeenCalledWith({
      where: { blockerId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(findIdentityBlocks).toHaveBeenCalledWith({
      where: { blockerUserId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
  });

  it('PRD-423: exports a matched chat block with no user id', async () => {
    const contributor = new BlocksExportContributor(
      repositoryWith<Block>({
        find: jest.fn().mockResolvedValue([
          {
            id: 'block-3',
            blockerId: 'user-1',
            blockedId: 'other-3',
            reason: null,
            matchedConversationId: 'chat-1',
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ]),
      }),
      repositoryWith<IdentityBlock>({ find: jest.fn().mockResolvedValue([]) }),
    );

    const [block] = (await contributor.buildContribution('user-1')) as Array<
      Record<string, unknown>
    >;

    expect(block).not.toHaveProperty('blockedUserId');
    expect(block!.isMatchedChatBlock).toBe(true);
  });

  it('merges member and identity blocks into one createdAt ASC list', async () => {
    const contributor = new BlocksExportContributor(
      repositoryWith<Block>({
        find: jest.fn().mockResolvedValue([
          {
            id: 'block-1',
            blockerId: 'user-1',
            blockedId: 'other-1',
            reason: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
          },
          {
            id: 'block-2',
            blockerId: 'user-1',
            blockedId: 'other-2',
            reason: 'harassment',
            createdAt: new Date('2026-03-01T00:00:00.000Z'),
          },
        ]),
      }),
      repositoryWith<IdentityBlock>({
        find: jest.fn().mockResolvedValue([
          {
            id: 'identity-block-1',
            blockerUserId: 'user-1',
            identityId: 'identity-1',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ]),
      }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        type: 'member',
        id: 'block-1',
        blockedUserId: 'other-1',
        reason: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        type: 'identity',
        id: 'identity-block-1',
        identityId: 'identity-1',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
      {
        type: 'member',
        id: 'block-2',
        blockedUserId: 'other-2',
        reason: 'harassment',
        createdAt: '2026-03-01T00:00:00.000Z',
      },
    ]);
  });

  // ENG-447: a block carried across a persona going unlinked exports as the
  // member's Blocked list shows it.
  it('exports a carried identity block under the retired identity and the named persona name', async () => {
    const contributor = new BlocksExportContributor(
      repositoryWith<Block>({ find: jest.fn().mockResolvedValue([]) }),
      repositoryWith<IdentityBlock>({
        find: jest.fn().mockResolvedValue([
          {
            id: 'carried-block-1',
            blockerUserId: 'user-1',
            identityId: null,
            blockedSubprofileId: 'persona-1',
            retiredIdentityId: 'retired-identity-1',
            blockedNameSnapshot: 'Robin Nightform',
            createdAt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ]),
      }),
    );

    await expect(contributor.buildContribution('user-1')).resolves.toEqual([
      {
        type: 'identity',
        id: 'carried-block-1',
        identityId: 'retired-identity-1',
        blockedName: 'Robin Nightform',
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ]);
  });
});

describe('ReportsFiledExportContributor', () => {
  const reportRow = {
    id: 'report-1',
    subjectType: ReportSubjectType.Message,
    subjectId: 'message-1',
    reasonCode: 'harassment',
    detail: 'Kept messaging after I said stop',
    anonymous: false,
    contactEmail: null,
    anonymousReporterKey: null,
    evidence: [
      { type: 'url', value: 'https://example.org/thread' },
      { type: 'screenshot', uploadId: 'upload-1' },
      { type: 'message-snapshot', messageId: 'message-1', body: 'their words' },
    ],
    severity: ReportSeverity.High,
    slaDueAt: new Date('2026-06-02T00:00:00.000Z'),
    status: ReportStatus.Resolved,
    reporterId: 'user-1',
    assignedModeratorId: 'moderator-1',
    assignedAt: new Date('2026-06-01T12:00:00.000Z'),
    resolvedAt: new Date('2026-06-01T15:00:00.000Z'),
    resolutionActorId: 'moderator-1',
    resolutionAction: 'restrict',
    resolutionDuration: '7d',
    resolutionNote: 'Restricted for a week',
    resolutionNotified: ['reporter'],
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
  } as Report;

  it('reads the reports the member filed, oldest first', async () => {
    const find = jest.fn().mockResolvedValue([]);
    const contributor = new ReportsFiledExportContributor(
      repositoryWith({ find }),
    );

    await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { reporterId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
  });

  it('PRD-423: names no user id for a member the reporter shares a matched chat with', async () => {
    const memberReport = {
      ...reportRow,
      id: 'report-2',
      subjectType: ReportSubjectType.Member,
      subjectId: 'user-matched',
    } as Report;
    const plainMemberReport = {
      ...reportRow,
      id: 'report-3',
      subjectType: ReportSubjectType.Member,
      subjectId: 'user-known',
    } as Report;
    const query = jest.fn().mockResolvedValue([{ userId: 'user-matched' }]);
    const contributor = new ReportsFiledExportContributor({
      find: jest.fn().mockResolvedValue([memberReport, plainMemberReport]),
      manager: { query },
    } as unknown as Repository<Report>);

    const [matched, plain] = (await contributor.buildContribution(
      'user-1',
    )) as Array<Record<string, unknown>>;

    expect(matched).not.toHaveProperty('subjectId');
    expect(matched!.isMatchedChatReport).toBe(true);
    expect(plain!.subjectId).toBe('user-known');
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      'user-1',
      ['user-matched', 'user-known'],
    ]);
  });

  it("exports the member's side and leaves out the moderation record", async () => {
    const contributor = new ReportsFiledExportContributor(
      repositoryWith({ find: jest.fn().mockResolvedValue([reportRow]) }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(result).toEqual([
      {
        id: 'report-1',
        subjectType: ReportSubjectType.Message,
        subjectId: 'message-1',
        reasonCode: 'harassment',
        detail: 'Kept messaging after I said stop',
        evidence: [
          { type: 'url', value: 'https://example.org/thread' },
          { type: 'screenshot', uploadId: 'upload-1' },
        ],
        anonymous: false,
        status: ReportStatus.Resolved,
        createdAt: '2026-06-01T00:00:00.000Z',
        resolvedAt: '2026-06-01T15:00:00.000Z',
      },
    ]);
  });
});

describe('PolicyAcceptancesExportContributor', () => {
  it('exports every acceptance the member recorded', async () => {
    const find = jest.fn().mockResolvedValue([
      {
        id: 'acceptance-1',
        userId: 'user-1',
        termsVersion: '1.1',
        guidelinesVersion: '1.2',
        previousTermsVersion: '1.0',
        previousGuidelinesVersion: null,
        source: PolicyAcceptanceSource.Reacceptance,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      } as PolicyAcceptance,
    ]);
    const contributor = new PolicyAcceptancesExportContributor(
      repositoryWith({ find }),
    );

    const result = await contributor.buildContribution('user-1');

    expect(find).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      order: { createdAt: 'ASC' },
    });
    expect(result).toEqual([
      {
        id: 'acceptance-1',
        termsVersion: '1.1',
        guidelinesVersion: '1.2',
        previousTermsVersion: '1.0',
        previousGuidelinesVersion: null,
        source: PolicyAcceptanceSource.Reacceptance,
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ]);
  });
});
