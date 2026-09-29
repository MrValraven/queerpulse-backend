import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, Repository } from 'typeorm';
import { encodeCursor } from '../common/cursor-pagination';
import { VALIDATION_PIPE_OPTIONS } from '../common/validation-pipe.options';
import { ConnectionsService } from '../connections/connections.service';
import { IdentityKind } from '../identities/entities/identity.entity';
import { IdentitiesService } from '../identities/identities.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { PreferencesService } from '../preferences/preferences.service';
import { foldSearchText } from '../search/search-text';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import {
  conversationKindPredicate,
  conversationNameSearchParameters,
  conversationNameSearchPredicate,
  normalizedListSearchTerm,
  stillSeatedPredicate,
} from './conversation-list-search';
import { ConversationsService } from './conversations.service';
import { ListConversationsQuery } from './dto/list-conversations.query';
import { ConversationParticipant } from './entities/conversation-participant.entity';
import { Conversation, ConversationKind } from './entities/conversation.entity';
import { MessagingCoreService } from './messaging-core.service';

/**
 * ENG-403: `GET /conversations?q=&kind=group`, the server-side search the
 * forward picker calls in place of paging the whole inbox in. The invariant
 * these cases protect: a search page is the plain list plus the search and
 * kind predicates on the caller's own seat, so every visibility rule of the
 * list (clear floor, `leftAt` ceiling, block filters, mailbox scoping)
 * still applies and the page stays bounded by `limit`.
 *
 * Query-shape checks over a mocked builder, like `mailbox-list-filter.spec.ts`.
 * The row-level behaviour needs a real Postgres to exercise.
 */

const USER_ID = 'user-1';
const MAILBOX_IDENTITY_ID = '6f1c2d3e-4b5a-4c6d-8e7f-001122334455';
const SEARCH_PREDICATE = conversationNameSearchPredicate('participant');
const KIND_PREDICATE = conversationKindPredicate('participant');
const STILL_SEATED_PREDICATE = stillSeatedPredicate('participant');

interface ParticipantsBuilderMock {
  where: jest.Mock;
  andWhere: jest.Mock;
  setParameter: jest.Mock;
  addSelect: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  getRawAndEntities: jest.Mock;
}

function makeParticipantsBuilder(): ParticipantsBuilderMock {
  const builder = {} as ParticipantsBuilderMock;
  const chain = (): ParticipantsBuilderMock => builder;
  builder.where = jest.fn(chain);
  builder.andWhere = jest.fn(chain);
  builder.setParameter = jest.fn(chain);
  builder.addSelect = jest.fn(chain);
  builder.orderBy = jest.fn(chain);
  builder.addOrderBy = jest.fn(chain);
  builder.take = jest.fn(chain);
  builder.getRawAndEntities = jest
    .fn()
    .mockResolvedValue({ entities: [], raw: [] });
  return builder;
}

function sqlOfCalls(mock: jest.Mock): string[] {
  return (mock.mock.calls as unknown[][]).map((call) => String(call[0]));
}

describe('conversation list search (ENG-403)', () => {
  describe('ListConversationsQuery', () => {
    const pipe = new ValidationPipe(VALIDATION_PIPE_OPTIONS);
    const metadata: ArgumentMetadata = {
      type: 'query',
      metatype: ListConversationsQuery,
    };

    it('accepts `q` and `kind=group`', async () => {
      const transformed = (await pipe.transform(
        { q: 'Pride', kind: 'group' },
        metadata,
      )) as ListConversationsQuery;
      expect(transformed.q).toBe('Pride');
      expect(transformed.kind).toBe(ConversationKind.Group);
    });

    it('refuses a `kind` other than group with a 400', async () => {
      await expect(
        pipe.transform({ kind: 'direct' }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a `q` longer than 200 characters with a 400', async () => {
      await expect(
        pipe.transform({ q: 'a'.repeat(201) }, metadata),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('turns `excludeLeft` on for the literal "true" alone', async () => {
      const turnedOn = (await pipe.transform(
        { excludeLeft: 'true' },
        metadata,
      )) as ListConversationsQuery;
      const leftOff = (await pipe.transform(
        { excludeLeft: '1' },
        metadata,
      )) as ListConversationsQuery;
      expect(turnedOn.excludeLeft).toBe(true);
      expect(leftOff.excludeLeft).toBe(false);
    });
  });

  describe('the predicate', () => {
    it('treats a blank term as no search', () => {
      expect(normalizedListSearchTerm(undefined)).toBeNull();
      expect(normalizedListSearchTerm('   ')).toBeNull();
      expect(normalizedListSearchTerm('  Inês ')).toBe('Inês');
    });

    it('escapes LIKE metacharacters so the term matches literally', () => {
      expect(
        conversationNameSearchParameters('50%_off\\').listSearchPattern,
      ).toBe('%50\\%\\_off\\\\%');
    });

    it('binds the group kind and the profile identity kind', () => {
      expect(conversationNameSearchParameters('x')).toMatchObject({
        listSearchGroupKind: ConversationKind.Group,
        listSearchProfileIdentityKind: IdentityKind.Profile,
      });
    });

    it('folds the needle and both haystacks with the shared accent fold', () => {
      expect(SEARCH_PREDICATE).toContain(
        "translate(lower(:listSearchPattern), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ'",
      );
      expect(SEARCH_PREDICATE).toContain(
        "translate(lower(coalesce(search_convo.title, ''))",
      );
      expect(SEARCH_PREDICATE.match(/ESCAPE '\\'/g)).toHaveLength(2);
      expect(foldSearchText('Inês São')).toBe('ines sao');
    });

    it('matches a group on its title alone, leaving its member names out', () => {
      const groupBranch = SEARCH_PREDICATE.slice(
        SEARCH_PREDICATE.indexOf('(search_convo.kind = :listSearchGroupKind'),
        SEARCH_PREDICATE.indexOf('OR (search_convo.kind <>'),
      );
      expect(groupBranch).toContain('search_convo.title');
      expect(groupBranch).not.toContain('search_profile');
    });

    it('matches a direct partner only through a personal profile seat, spelled like displayNameFor', () => {
      expect(SEARCH_PREDICATE).toContain('search_convo.is_official = false');
      expect(SEARCH_PREDICATE).toContain(
        'search_identity.kind = :listSearchProfileIdentityKind',
      );
      expect(SEARCH_PREDICATE).toContain('search_other.user_id <> :userId');
      expect(SEARCH_PREDICATE).toMatch(
        /WHEN search_convo\.is_go_together_chat OR search_convo\.event_match_group_id IS NOT NULL\s+THEN coalesce\(search_profile\.first_name, ''\)/,
      );
    });

    it('filters the kind on the seat conversation', () => {
      expect(KIND_PREDICATE).toContain('kind_convo.kind = :listKind');
      expect(KIND_PREDICATE).toContain(
        'kind_convo.id = participant.conversation_id',
      );
    });
  });

  describe('ConversationsService.listConversations', () => {
    let service: ConversationsService;
    let builder: ParticipantsBuilderMock;
    let participants: { createQueryBuilder: jest.Mock };

    beforeEach(() => {
      builder = makeParticipantsBuilder();
      participants = { createQueryBuilder: jest.fn(() => builder) };
      service = new ConversationsService(
        {} as Repository<Conversation>,
        participants as unknown as Repository<ConversationParticipant>,
        {} as Repository<Profile>,
        {} as MessagingCoreService,
        {} as BlockFilterService,
        { emit: jest.fn() } as unknown as EventEmitter2,
        {} as DataSource,
        {} as MediaCropService,
        {} as ConnectionsService,
        {} as PreferencesService,
        {
          isAllowedToActAs: jest.fn().mockResolvedValue(true),
        } as unknown as IdentitiesService,
        {} as never,
      );
    });

    it('adds no predicate when neither `search`, `kind` nor `excludeLeft` is given', async () => {
      await service.listConversations(USER_ID, {});

      const andWhereSql = sqlOfCalls(builder.andWhere);
      expect(andWhereSql).not.toContain(SEARCH_PREDICATE);
      expect(andWhereSql).not.toContain(KIND_PREDICATE);
      expect(andWhereSql).not.toContain(STILL_SEATED_PREDICATE);
    });

    it('keeps left groups under `kind` alone, the plain list rule', async () => {
      await service.listConversations(USER_ID, {
        kind: ConversationKind.Group,
      });

      expect(sqlOfCalls(builder.andWhere)).not.toContain(
        STILL_SEATED_PREDICATE,
      );
    });

    it('drops every conversation the caller left once `excludeLeft` is on', async () => {
      await service.listConversations(USER_ID, {
        kind: ConversationKind.Group,
        excludeLeft: true,
      });

      expect(STILL_SEATED_PREDICATE).toBe('participant.left_at IS NULL');
      expect(sqlOfCalls(builder.andWhere)).toContain(STILL_SEATED_PREDICATE);
    });

    it('adds no predicate for a blank search', async () => {
      await service.listConversations(USER_ID, { search: '   ' });

      expect(sqlOfCalls(builder.andWhere)).not.toContain(SEARCH_PREDICATE);
    });

    it('is the plain list plus the search and kind predicates, bound as parameters', async () => {
      const plain = makeParticipantsBuilder();
      participants.createQueryBuilder.mockReturnValueOnce(plain);
      await service.listConversations(USER_ID, {});

      await service.listConversations(USER_ID, {
        search: ' Pride ',
        kind: ConversationKind.Group,
      });

      expect(sqlOfCalls(builder.andWhere)).toEqual([
        ...sqlOfCalls(plain.andWhere),
        SEARCH_PREDICATE,
        KIND_PREDICATE,
      ]);
      expect(builder.andWhere).toHaveBeenCalledWith(
        SEARCH_PREDICATE,
        conversationNameSearchParameters('Pride'),
      );
      expect(builder.andWhere).toHaveBeenCalledWith(KIND_PREDICATE, {
        listKind: ConversationKind.Group,
      });
      // The raw term is never spliced into the SQL text.
      expect(sqlOfCalls(builder.andWhere).join('\n')).not.toContain('Pride');
    });

    it('composes with the mailbox filter and lands before the keyset seek and the take', async () => {
      const cursor = encodeCursor({
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        id: 'participant-9',
      });
      await service.listConversations(USER_ID, {
        cursor,
        limit: 20,
        mailboxIdentityId: MAILBOX_IDENTITY_ID,
        search: 'Pride',
        kind: ConversationKind.Group,
        excludeLeft: true,
      });

      const andWhereSql = sqlOfCalls(builder.andWhere);
      const mailboxIndex = andWhereSql.indexOf(
        'participant.identity_id = :mailboxIdentityId',
      );
      const searchIndex = andWhereSql.indexOf(SEARCH_PREDICATE);
      const kindIndex = andWhereSql.indexOf(KIND_PREDICATE);
      const stillSeatedIndex = andWhereSql.indexOf(STILL_SEATED_PREDICATE);
      const cursorIndex = andWhereSql.findIndex((sql) =>
        sql.includes(':cursorParticipantId'),
      );
      expect(mailboxIndex).toBeGreaterThanOrEqual(0);
      expect(searchIndex).toBeGreaterThan(mailboxIndex);
      expect(kindIndex).toBeGreaterThan(searchIndex);
      expect(stillSeatedIndex).toBeGreaterThan(kindIndex);
      expect(cursorIndex).toBeGreaterThan(stillSeatedIndex);
      expect(builder.take).toHaveBeenCalledWith(21);
    });
  });
});
