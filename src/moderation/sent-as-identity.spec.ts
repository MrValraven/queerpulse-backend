import type { DataSource } from 'typeorm';
import { IdentityKind } from '../identities/entities/identity.entity';
import { MessageKind } from '../messaging/entities/message.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { ReportConversationContextService } from './report-conversation-context.service';
import { ReportSubjectResolverService } from './report-subject-resolver.service';
import { loadSentAsIdentities } from './sent-as-identity';

// Business mailboxes, design section 9: the moderator view shows the identity
// a message was sent as and the human who sent it.

const REPORTED_MESSAGE_ID = '11111111-2222-4333-8444-555555555555';
const BUSINESS_MESSAGE_ID = '22222222-2222-4333-8444-555555555555';
const PERSONAL_MESSAGE_ID = '33333333-2222-4333-8444-555555555555';
const BUSINESS_IDENTITY_ID = '44444444-2222-4333-8444-555555555555';
const DELETED_IDENTITY_ID = '55555555-2222-4333-8444-555555555555';
const PROFILE_IDENTITY_ID = '66666666-2222-4333-8444-555555555555';
const CONVERSATION_ID = '77777777-2222-4333-8444-555555555555';

function identitiesStub(resolved: Array<{ id: string; kind: IdentityKind }>) {
  return {
    getByIds: jest.fn().mockResolvedValue(resolved),
    describeIdentities: jest.fn((identityIds: string[]) =>
      Promise.resolve(
        new Map(
          identityIds.map((identityId) => [
            identityId,
            {
              displayName: 'Cafe Lisboa',
              handle: 'cafe-lisboa',
              avatarUrl: null,
            },
          ]),
        ),
      ),
    ),
  };
}

describe('loadSentAsIdentities', () => {
  it('names a business identity, a deleted identity with a live sender, and skips a profile identity', async () => {
    const identities = identitiesStub([
      { id: BUSINESS_IDENTITY_ID, kind: IdentityKind.Listing },
      { id: PROFILE_IDENTITY_ID, kind: IdentityKind.Profile },
    ]);

    const sentAs = await loadSentAsIdentities(identities, [
      { senderId: 'staff-user', senderIdentityId: BUSINESS_IDENTITY_ID },
      { senderId: 'staff-user', senderIdentityId: DELETED_IDENTITY_ID },
      { senderId: 'customer-user', senderIdentityId: PROFILE_IDENTITY_ID },
      { senderId: null, senderIdentityId: null },
    ]);

    expect([...sentAs.keys()].sort()).toEqual(
      [BUSINESS_IDENTITY_ID, DELETED_IDENTITY_ID].sort(),
    );
    expect(sentAs.get(BUSINESS_IDENTITY_ID)).toEqual({
      identityId: BUSINESS_IDENTITY_ID,
      kind: IdentityKind.Listing,
      displayName: 'Cafe Lisboa',
      handle: 'cafe-lisboa',
    });
    expect(sentAs.get(DELETED_IDENTITY_ID)).toEqual({
      identityId: DELETED_IDENTITY_ID,
      kind: null,
      displayName: null,
      handle: null,
    });
    // The profile identity is never described: it is the sender themself.
    expect(identities.describeIdentities).toHaveBeenCalledWith([
      BUSINESS_IDENTITY_ID,
    ]);
  });

  it('reads nothing when no candidate carries an identity', async () => {
    const identities = identitiesStub([]);

    const sentAs = await loadSentAsIdentities(identities, [
      { senderId: 'member', senderIdentityId: null },
    ]);

    expect(sentAs.size).toBe(0);
    expect(identities.getByIds).not.toHaveBeenCalled();
  });
});

describe('ReportSubjectResolverService on a message subject', () => {
  it('carries the identity the message was sent as beside its human author', async () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM messages m')
          ? [
              {
                key: REPORTED_MESSAGE_ID,
                author_user_id: 'staff-user',
                excerpt: 'We are closed on Mondays.',
                community_id: null,
                conversation_id: CONVERSATION_ID,
                sender_identity_id: BUSINESS_IDENTITY_ID,
              },
            ]
          : [],
      ),
    );
    const resolver = new ReportSubjectResolverService({
      query,
    } as unknown as DataSource);

    const resolution = await resolver.resolve({
      subjectType: ReportSubjectType.Message,
      subjectId: REPORTED_MESSAGE_ID,
    } as Report);

    expect(resolution.authorUserId).toBe('staff-user');
    expect(resolution.senderIdentityId).toBe(BUSINESS_IDENTITY_ID);
    const [messageSql] = query.mock.calls.find(([sql]) =>
      sql.includes('FROM messages m'),
    )!;
    expect(messageSql).toContain('m.sender_identity_id AS sender_identity_id');
  });
});

describe('ReportConversationContextService names the identity of each message', () => {
  function message(
    id: string,
    senderId: string,
    senderIdentityId: string | null,
    createdAt: string,
  ) {
    return {
      id,
      conversationId: CONVERSATION_ID,
      senderId,
      senderIdentityId,
      kind: MessageKind.User,
      body: `body of ${id}`,
      attachment: null,
      createdAt: new Date(createdAt),
      editedAt: null,
      deletedAt: null,
    };
  }

  it('shows the business beside the staff sender, and nothing extra on a personal message', async () => {
    const earlier = [
      message(
        PERSONAL_MESSAGE_ID,
        'customer-user',
        PROFILE_IDENTITY_ID,
        '2026-09-01T10:00:00.000Z',
      ),
    ];
    const anchorAndLater = [
      message(
        REPORTED_MESSAGE_ID,
        'staff-user',
        BUSINESS_IDENTITY_ID,
        '2026-09-01T10:01:00.000Z',
      ),
      message(
        BUSINESS_MESSAGE_ID,
        'colleague-user',
        BUSINESS_IDENTITY_ID,
        '2026-09-01T10:02:00.000Z',
      ),
    ];
    const windowResults = [earlier, anchorAndLater];
    const queryBuilder = () => {
      const builder: Record<string, jest.Mock> = {};
      for (const method of [
        'withDeleted',
        'where',
        'setParameter',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'limit',
      ]) {
        builder[method] = jest.fn(() => builder);
      }
      builder.getMany = jest.fn(() => Promise.resolve(windowResults.shift()));
      return builder;
    };
    const service = new ReportConversationContextService(
      {
        findOne: jest.fn().mockResolvedValue({
          id: 'report-1',
          subjectType: ReportSubjectType.Message,
          subjectId: REPORTED_MESSAGE_ID,
          evidence: null,
          severity: ReportSeverity.High,
          status: ReportStatus.Open,
        }),
      } as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: REPORTED_MESSAGE_ID,
          conversationId: CONVERSATION_ID,
        }),
        createQueryBuilder: jest.fn(queryBuilder),
      } as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            userId: 'staff-user',
            firstName: 'Rui',
            lastName: 'Staff',
            slug: 'rui-staff',
          },
          {
            userId: 'colleague-user',
            firstName: 'Ana',
            lastName: 'Staff',
            slug: 'ana-staff',
          },
          {
            userId: 'customer-user',
            firstName: 'Maria',
            lastName: 'Customer',
            slug: 'maria-customer',
          },
        ]),
      } as never,
      { writeAuditLog: jest.fn().mockResolvedValue(undefined) } as never,
      identitiesStub([
        { id: BUSINESS_IDENTITY_ID, kind: IdentityKind.Listing },
        { id: PROFILE_IDENTITY_ID, kind: IdentityKind.Profile },
      ]) as never,
    );

    const context = await service.getContext('report-1', 'moderator-1');

    const byId = new Map(context.messages.map((entry) => [entry.id, entry]));
    const businessIdentity = {
      identityId: BUSINESS_IDENTITY_ID,
      kind: IdentityKind.Listing,
      displayName: 'Cafe Lisboa',
      handle: 'cafe-lisboa',
    };
    expect(byId.get(REPORTED_MESSAGE_ID)).toEqual(
      expect.objectContaining({
        senderId: 'staff-user',
        senderSlug: 'rui-staff',
        sentAsIdentity: businessIdentity,
        isReportedMessage: true,
      }),
    );
    expect(byId.get(BUSINESS_MESSAGE_ID)).toEqual(
      expect.objectContaining({
        senderSlug: 'ana-staff',
        sentAsIdentity: businessIdentity,
      }),
    );
    expect(byId.get(PERSONAL_MESSAGE_ID)).toEqual(
      expect.objectContaining({
        senderSlug: 'maria-customer',
        sentAsIdentity: null,
      }),
    );
  });
});
