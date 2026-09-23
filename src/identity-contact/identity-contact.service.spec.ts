import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MessageRequestsService } from '../messaging/message-requests.service';
import { MessagingCoreService } from '../messaging/messaging-core.service';
import { MessagingService } from '../messaging/messaging.service';
import { SubprofileLinkVisibility } from '../subprofiles/entities/subprofile.entity';
import { CompanyContactController } from './company-contact.controller';
import { IdentityContactService } from './identity-contact.service';
import { PersonaContactController } from './persona-contact.controller';

/**
 * Task 18: "Message" on a persona and on a company. The controllers, the
 * real `IdentityContactService`, the real `MessagingService` facade,
 * `MessageRequestsService` and `MessagingCoreService` thread logic all run;
 * only storage, identities and cross-domain services are stubbed.
 */

interface SavedRow {
  [column: string]: unknown;
}

const PERSONA_ID = '11111111-1111-4111-8111-111111111111';
const PERSONA_IDENTITY = 'persona-identity';
const COMPANY_IDENTITY = 'company-identity';
const HOUR_MS = 60 * 60 * 1000;

const customer = { userId: 'customer-user' } as never;

function makeContact(
  options: {
    persona?: SavedRow | null;
    isPersonaUnderTakedown?: boolean;
    isPersonaRemoved?: boolean;
    company?: SavedRow | null;
    companyStaff?: string[];
    extraStaff?: Record<string, string[]>;
    identityBlocked?: boolean;
    coldMessageRows?: Array<{ conversationId: string; createdAt: Date }>;
    listingEnquiryRows?: Array<{ listingId: string; createdAt: Date }>;
    personBlockedUserIds?: string[];
    existingConversations?: SavedRow[];
  } = {},
) {
  const staffByIdentityId: Record<string, string[]> = {
    [PERSONA_IDENTITY]: ['persona-owner', 'persona-coowner'],
    [COMPANY_IDENTITY]: options.companyStaff ?? ['company-owner'],
    ...(options.extraStaff ?? {}),
  };
  const kindByIdentityId: Record<string, IdentityKind> = {
    [PERSONA_IDENTITY]: IdentityKind.Subprofile,
    [COMPANY_IDENTITY]: IdentityKind.Company,
  };
  const savedConversations: SavedRow[] = [
    ...(options.existingConversations ?? []),
  ];
  const savedSeats: SavedRow[] = [];
  const identities = {
    getById: jest.fn((identityId: string) =>
      Promise.resolve(
        identityId.startsWith('profile-')
          ? { id: identityId, kind: IdentityKind.Profile }
          : {
              id: identityId,
              kind: kindByIdentityId[identityId] ?? IdentityKind.Listing,
            },
      ),
    ),
    resolveProfileIdentityId: jest.fn((userId: string) =>
      Promise.resolve(`profile-${userId}`),
    ),
    staffUserIds: jest.fn((identityId: string) =>
      Promise.resolve(staffByIdentityId[identityId] ?? []),
    ),
    isRemovedPersona: jest.fn((identity: { id: string }) =>
      Promise.resolve(
        Boolean(options.isPersonaRemoved) && identity.id === PERSONA_IDENTITY,
      ),
    ),
    assertMayActAs: jest.fn((userId: string, identityId: string) =>
      (staffByIdentityId[identityId] ?? []).includes(userId)
        ? Promise.resolve()
        : Promise.reject(
            new ForbiddenException({ code: 'IDENTITY_NOT_STAFF' }),
          ),
    ),
    ensureIdentityFor: jest.fn((kind: IdentityKind) =>
      Promise.resolve({
        id:
          kind === IdentityKind.Subprofile
            ? PERSONA_IDENTITY
            : COMPANY_IDENTITY,
      }),
    ),
  };
  const transaction = jest.fn((run: (manager: unknown) => Promise<unknown>) =>
    run({
      create: (_entity: unknown, row: SavedRow) => ({ ...row }),
      save: (rows: SavedRow | SavedRow[]) => {
        if (Array.isArray(rows)) {
          savedSeats.push(...rows);
          return Promise.resolve(rows);
        }
        const conversation = { ...rows, id: 'mailbox-conversation' };
        savedConversations.push(conversation);
        return Promise.resolve(conversation);
      },
    }),
  );
  const postMessage = jest.fn(() =>
    Promise.resolve({ view: {}, response: {}, isNew: true }),
  );
  const core = Object.create(
    MessagingCoreService.prototype,
  ) as MessagingCoreService;
  Object.assign(core, {
    identities,
    conversations: {
      findOne: jest.fn(({ where }: { where: { pairKey: string } }) =>
        Promise.resolve(
          savedConversations.find(
            (conversation) => conversation.pairKey === where.pairKey,
          ) ?? null,
        ),
      ),
      update: jest.fn(() => Promise.resolve()),
    },
    dataSource: { transaction },
    postMessage,
  });
  const personBlockedUserIds = options.personBlockedUserIds ?? [];
  const blockFilter = {
    isIdentityBlocked: jest.fn(() =>
      Promise.resolve(Boolean(options.identityBlocked)),
    ),
    blockedUserIds: jest.fn((userId: string, candidateUserIds: string[]) =>
      Promise.resolve(
        new Set(
          candidateUserIds.filter(
            (candidateUserId) =>
              candidateUserId !== userId &&
              personBlockedUserIds.includes(candidateUserId),
          ),
        ),
      ),
    ),
    isBlockedEitherWay: jest.fn((firstUserId: string, secondUserId: string) =>
      Promise.resolve(
        firstUserId !== secondUserId &&
          (personBlockedUserIds.includes(firstUserId) ||
            personBlockedUserIds.includes(secondUserId)),
      ),
    ),
  };
  const requests = new MessageRequestsService(
    {} as never,
    core,
    {
      areConnected: jest.fn(() => Promise.resolve(false)),
      assertRequestsNotPaused: jest.fn(() => Promise.resolve()),
    } as never,
    blockFilter as never,
    { resyncConversation: jest.fn(() => Promise.resolve([])) } as never,
  );
  const messaging = Object.create(
    MessagingService.prototype,
  ) as MessagingService;
  Object.assign(messaging, { messageRequestsService: requests });
  const persona =
    options.persona === undefined
      ? {
          id: PERSONA_ID,
          slug: 'drag-night',
          userId: 'persona-owner',
          linkVisibility: SubprofileLinkVisibility.Unlinked,
        }
      : options.persona;
  const subprofiles = { findOne: jest.fn(() => Promise.resolve(persona)) };
  const company =
    options.company === undefined
      ? { id: 'company-1', slug: 'acme' }
      : options.company;
  const companies = { findOne: jest.fn(() => Promise.resolve(company)) };
  // Two bounded reads: the persona and company cold messages, and the
  // directory's own `listing_enquiries` rows (the shared daily ceiling).
  const messages = {
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('"listing_enquiries"')
          ? (options.listingEnquiryRows ?? [])
          : (options.coldMessageRows ?? []),
      ),
    ),
  };
  const contentModeration = {
    stateFor: jest.fn((subjectType: string) =>
      Promise.resolve({
        hidden:
          subjectType === 'subprofile' &&
          Boolean(options.isPersonaUnderTakedown),
        removed: false,
      }),
    ),
  };
  const service = new IdentityContactService(
    subprofiles as never,
    companies as never,
    messages as never,
    identities as never,
    messaging,
    contentModeration as never,
    blockFilter as never,
  );
  return {
    personaController: new PersonaContactController(service),
    companyController: new CompanyContactController(service),
    savedConversations,
    savedSeats,
    postMessage,
    transaction,
    subprofiles,
    messages,
  };
}

const coldRows = (conversationId: string, hoursAgo: number[]) =>
  [...hoursAgo]
    .sort((left, right) => left - right)
    .map((hours) => ({
      conversationId,
      createdAt: new Date(Date.now() - hours * HOUR_MS),
    }));

describe('persona contact', () => {
  it('delivers into the persona mailbox, seating the owner and every co-owner, and an unlinked persona is contactable', async () => {
    const { personaController, savedConversations, savedSeats, postMessage } =
      makeContact();

    const result = await personaController.send(customer, PERSONA_ID, {
      body: 'Are you taking bookings for December?',
    });

    expect(result).toEqual({
      conversationId: 'mailbox-conversation',
      followUpAwaitsReply: true,
    });
    expect(savedConversations[0]?.pairKey).toBe(
      ['profile-customer-user', PERSONA_IDENTITY].sort().join(':'),
    );
    expect(savedSeats.map((seat) => [seat.userId, seat.identityId])).toEqual([
      ['customer-user', 'profile-customer-user'],
      ['persona-owner', PERSONA_IDENTITY],
      ['persona-coowner', PERSONA_IDENTITY],
    ]);
    expect(postMessage).toHaveBeenCalledWith(
      'mailbox-conversation',
      'customer-user',
      'Are you taking bookings for December?',
    );
  });

  it('never names the humans behind the persona in either answer', async () => {
    const { personaController } = makeContact();

    const contact = await personaController.getContact(customer, PERSONA_ID);
    const sent = await personaController.send(customer, PERSONA_ID, {
      body: 'Are you taking bookings for December?',
    });

    const wire = JSON.stringify({ contact, sent });
    expect(wire).not.toContain('persona-owner');
    expect(wire).not.toContain('persona-coowner');
  });

  it('reads only published personas that are open or network, whatever their link visibility', async () => {
    const { personaController, subprofiles } = makeContact();

    await personaController.getContact(customer, PERSONA_ID);

    const [query] = subprofiles.findOne.mock.calls[0] as unknown as [
      { where: Record<string, unknown> },
    ];
    expect(query.where).toMatchObject({
      id: PERSONA_ID,
      status: 'published',
    });
    expect(JSON.stringify(query.where.visibility)).toContain('open');
    expect(JSON.stringify(query.where.visibility)).toContain('network');
    expect(JSON.stringify(query.where.visibility)).not.toContain('private');
    expect(query.where).not.toHaveProperty('linkVisibility');
  });

  it('404s a persona the member could not see', async () => {
    const { personaController } = makeContact({ persona: null });

    await expect(
      personaController.getContact(customer, PERSONA_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('404s a persona under a moderator takedown', async () => {
    const { personaController, transaction } = makeContact({
      isPersonaUnderTakedown: true,
    });

    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses a persona moderation removed, with its code, before and at the send', async () => {
    const { personaController, transaction } = makeContact({
      isPersonaRemoved: true,
    });

    await expect(
      personaController.getContact(customer, PERSONA_ID),
    ).resolves.toMatchObject({
      canMessage: false,
      unavailableReason: 'removed',
    });
    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_REMOVED' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('tells a co-owner it is their own mailbox', async () => {
    const { personaController } = makeContact();

    await expect(
      personaController.getContact(
        { userId: 'persona-coowner' } as never,
        PERSONA_ID,
      ),
    ).resolves.toMatchObject({
      canMessage: false,
      unavailableReason: 'own_mailbox',
    });
  });

  it('refuses the member’s block of the persona with the IDENTITY_BLOCKED 403', async () => {
    const { personaController, transaction } = makeContact({
      identityBlocked: true,
    });

    await expect(
      personaController.getContact(customer, PERSONA_ID),
    ).resolves.toMatchObject({
      canMessage: false,
      unavailableReason: 'unavailable',
    });
    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).rejects.toThrow(
      new ForbiddenException('You cannot contact this business'),
    );
    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_BLOCKED' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  // Fix round 1 (c2): the persona page 404s a persona whose owner and the
  // viewer are person-blocked either way, and contact answers the same.
  it.each([
    [
      'the member blocked the owner, or the owner blocked the member',
      'persona-owner',
    ],
    [
      'the block is read either way, from the member’s side too',
      'customer-user',
    ],
  ])(
    '404s both the read and the send when %s',
    async (_description, blockedUserId) => {
      const { personaController, transaction } = makeContact({
        personBlockedUserIds: [blockedUserId],
      });

      await expect(
        personaController.getContact(customer, PERSONA_ID),
      ).rejects.toThrow(new NotFoundException('Subprofile not found'));
      await expect(
        personaController.send(customer, PERSONA_ID, {
          body: 'A question here.',
        }),
      ).rejects.toThrow(NotFoundException);
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('does not withhold the persona over a block with a co-owner, as the page does not', async () => {
    const { personaController, postMessage } = makeContact({
      personBlockedUserIds: ['persona-coowner'],
    });

    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).resolves.toMatchObject({ conversationId: 'mailbox-conversation' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('company contact', () => {
  // Fix round 1 (c2 stays persona only): a company keeps the no-refusal
  // rule for a block with one staff member.
  it('delivers although the member is blocked with one of two staff members', async () => {
    const { companyController, postMessage } = makeContact({
      companyStaff: ['company-owner', 'team-member'],
      personBlockedUserIds: ['company-owner'],
    });

    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).resolves.toMatchObject({ conversationId: 'mailbox-conversation' });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  // Fix round 1 (c1): nobody reachable reads as the identity block does.
  it('refuses as blocked when every staff member is person-blocked with the member', async () => {
    const { companyController, transaction } = makeContact({
      companyStaff: ['company-owner', 'team-member'],
      personBlockedUserIds: ['company-owner', 'team-member'],
    });

    await expect(
      companyController.getContact(customer, 'acme'),
    ).resolves.toMatchObject({
      canMessage: false,
      unavailableReason: 'unavailable',
    });
    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).rejects.toMatchObject({
      response: {
        code: 'IDENTITY_BLOCKED',
        message: 'You cannot contact this business',
      },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('delivers into the company mailbox, seating every team member', async () => {
    const { companyController, savedSeats } = makeContact({
      companyStaff: ['company-owner', 'team-member'],
    });

    await companyController.send(customer, 'acme', {
      body: 'Are you hiring for the spring?',
    });

    expect(savedSeats.map((seat) => [seat.userId, seat.identityId])).toEqual([
      ['customer-user', 'profile-customer-user'],
      ['company-owner', COMPANY_IDENTITY],
      ['team-member', COMPANY_IDENTITY],
    ]);
  });

  it('refuses a company nobody answers, and says so in advance', async () => {
    const { companyController, transaction } = makeContact({
      companyStaff: [],
    });

    await expect(
      companyController.getContact(customer, 'acme'),
    ).resolves.toMatchObject({
      canMessage: false,
      unavailableReason: 'unstaffed',
    });
    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).rejects.toMatchObject({ response: { code: 'IDENTITY_HAS_NO_STAFF' } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('404s a company that does not exist', async () => {
    const { companyController } = makeContact({ company: null });

    await expect(
      companyController.getContact(customer, 'acme'),
    ).rejects.toThrow(NotFoundException);
  });

  /**
   * Task 8's reply-only guard, reached by a real request: a persona owner,
   * with their persona selected in the mailbox switcher, presses Message on
   * a company page. `assertInitiatorIsProfile` refuses it before any thread
   * or message exists.
   */
  it('refuses a member acting as their persona with IDENTITY_CANNOT_INITIATE', async () => {
    const { companyController, transaction, postMessage } = makeContact();

    await expect(
      companyController.send({ userId: 'persona-owner' } as never, 'acme', {
        body: 'A question from us.',
        asIdentityId: PERSONA_IDENTITY,
      }),
    ).rejects.toMatchObject({
      response: { code: 'IDENTITY_CANNOT_INITIATE' },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('the counted caps', () => {
  it('429s the fourth cold message to one mailbox in a day, and the read says so first', async () => {
    const { companyController, postMessage } = makeContact({
      existingConversations: [
        {
          id: 'existing-conversation',
          pairKey: ['profile-customer-user', COMPANY_IDENTITY].sort().join(':'),
          initiatorUserId: 'customer-user',
          openedAt: null,
        },
      ],
      coldMessageRows: coldRows('existing-conversation', [20, 10, 2]),
    });

    await expect(
      companyController.getContact(customer, 'acme'),
    ).resolves.toMatchObject({
      canMessage: true,
      hasReachedEnquiryLimit: true,
      enquiryLimitReason: 'wrote_to_this_mailbox_today',
    });
    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).rejects.toThrow(
      new HttpException(
        'You have already written here today. Give them a chance to reply first.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('429s once twenty cold messages went out across persona and company mailboxes today', async () => {
    const { personaController, postMessage } = makeContact({
      coldMessageRows: coldRows(
        'elsewhere',
        Array.from({ length: 20 }, (unused, index) => index + 1),
      ),
    });

    await expect(
      personaController.send(customer, PERSONA_ID, {
        body: 'A question here.',
      }),
    ).rejects.toThrow(
      new HttpException(
        'You have sent a lot of enquiries today. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('counts both caps from two bounded reads for the member', async () => {
    const { personaController, messages } = makeContact();

    await personaController.send(customer, PERSONA_ID, {
      body: 'A question here.',
    });

    expect(messages.query).toHaveBeenCalledTimes(2);
    for (const [, parameters] of messages.query.mock.calls as unknown as Array<
      [string, unknown[]]
    >) {
      expect(parameters[0]).toBe('customer-user');
      expect(parameters[2]).toBe(21);
    }
  });

  // Fix round 1: ONE daily ceiling across directory, persona and company.
  it('shares the daily ceiling with directory enquiries: 8 directory, 6 persona and 6 company messages today refuse the next', async () => {
    const { companyController, postMessage } = makeContact({
      listingEnquiryRows: Array.from({ length: 8 }, (unused, index) => ({
        listingId: `listing-${index}`,
        createdAt: new Date(Date.now() - (index + 1) * HOUR_MS),
      })),
      coldMessageRows: [
        ...coldRows('persona-thread', [1.5, 2.5, 3.5]),
        ...coldRows('other-persona-thread', [4.5, 5.5, 6.5]),
        ...coldRows('company-thread', [7.5, 8.5, 9.5]),
        ...coldRows('other-company-thread', [10.5, 11.5, 12.5]),
      ],
    });

    await expect(
      companyController.getContact(customer, 'acme'),
    ).resolves.toMatchObject({
      hasReachedEnquiryLimit: true,
      enquiryLimitReason: 'wrote_across_mailboxes_today',
    });
    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).rejects.toThrow(
      new HttpException(
        'You have sent a lot of enquiries today. Try again tomorrow.',
        HttpStatus.TOO_MANY_REQUESTS,
      ),
    );
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('lets the send through at 19 across all kinds', async () => {
    const { companyController } = makeContact({
      listingEnquiryRows: Array.from({ length: 7 }, (unused, index) => ({
        listingId: `listing-${index}`,
        createdAt: new Date(Date.now() - (index + 1) * HOUR_MS),
      })),
      coldMessageRows: [
        ...coldRows('persona-thread', [1.5, 2.5, 3.5]),
        ...coldRows('other-persona-thread', [4.5, 5.5, 6.5]),
        ...coldRows('company-thread', [7.5, 8.5, 9.5]),
        ...coldRows('other-company-thread', [10.5, 11.5, 12.5]),
      ],
    });

    await expect(
      companyController.send(customer, 'acme', { body: 'A question here.' }),
    ).resolves.toMatchObject({ conversationId: 'mailbox-conversation' });
  });
});
