import { escapeLikeTerm } from '../common/like-escape';
import { IdentityKind } from '../identities/entities/identity.entity';
import { foldedSearchTerm, foldedTextExpression } from '../search/search-text';
import { ConversationKind } from './entities/conversation.entity';

/**
 * ENG-403: the name search and the kind filter of `GET /conversations`
 * (`ConversationsService.listConversations`). Both are `EXISTS` predicates
 * over the caller's own seat, so they AND onto every visibility rule the list
 * already applies (clear floor, `leftAt` ceiling, block filters, mailbox
 * scoping) and the list builder keeps its plain `LIMIT`: a search page is a
 * subset of the plain page, bounded by the same `limit`.
 *
 * Every alias here is lowercase, so none of them needs quoting.
 */

/** The paginated call's options of `ConversationsService.listConversations`. */
export interface ListConversationsOptions {
  cursor?: string;
  limit?: number;
  mailboxIdentityId?: string;
  /** The name search (`q`), see `conversationNameSearchPredicate`. */
  search?: string;
  /** Keeps only conversations of this kind (`kind`). */
  kind?: ConversationKind;
  /** Keeps only conversations the caller still holds a seat in
   *  (`excludeLeft`), see `stillSeatedPredicate`. */
  excludeLeft?: boolean;
}

/** SQL that holds while the seat `participantAlias` has not left its
 *  conversation: `left_at` is set both when a member leaves a group and when
 *  one is removed from it, and never on a direct thread. */
export function stillSeatedPredicate(participantAlias: string): string {
  return `${participantAlias}.left_at IS NULL`;
}

/** The bound parameters `conversationNameSearchPredicate` reads. */
export interface ConversationNameSearchParameters {
  listSearchPattern: string;
  listSearchGroupKind: ConversationKind;
  listSearchProfileIdentityKind: IdentityKind;
}

/**
 * The trimmed search text, or null when there is nothing to search for.
 * A blank `q` narrows nothing, the same as an absent one.
 */
export function normalizedListSearchTerm(
  rawTerm: string | undefined,
): string | null {
  const term = rawTerm?.trim() ?? '';
  return term.length > 0 ? term : null;
}

/** The parameters for `conversationNameSearchPredicate`, with the term's
 *  LIKE metacharacters escaped so it matches literally. */
export function conversationNameSearchParameters(
  term: string,
): ConversationNameSearchParameters {
  return {
    listSearchPattern: `%${escapeLikeTerm(term)}%`,
    listSearchGroupKind: ConversationKind.Group,
    listSearchProfileIdentityKind: IdentityKind.Profile,
  };
}

/**
 * SQL that holds when the conversation of the seat `participantAlias` shows a
 * name containing `:listSearchPattern`, folded for case and accents on both
 * sides (`foldedTextExpression`, as every backend search folds).
 *
 * The name is the one the list row displays, and only that:
 *
 * - A group matches on its title. Its members' names are not searched, so a
 *   matched Go together chat (PRD-423, first names only) can never be found
 *   by a surname the chat withholds.
 * - A direct thread matches on the partner's name, spelled the way
 *   `displayNameFor` spells it (`memberNameOptionsFor`: first name alone
 *   when the conversation carries `is_go_together_chat` or
 *   `event_match_group_id`, first and last otherwise). Only a seat held as a personal profile identity is read,
 *   which is exactly the seat `renderDirectCounterpart` names by profile: a
 *   customer's seat for the staff of a business mailbox, the other member
 *   on an ordinary DM. A seat held for a business, persona or company
 *   identity is left out, so a customer can never find a business thread by
 *   the private name of someone who staffs it, and a persona is never found
 *   by its owner's own name.
 * - An official thread matches nothing: it has no partner of its own.
 *
 * `:userId` is the caller, already bound by the list query.
 */
export function conversationNameSearchPredicate(
  participantAlias: string,
): string {
  const foldedPattern = foldedSearchTerm('listSearchPattern');
  const displayedPartnerName = `CASE
      WHEN search_convo.is_go_together_chat OR search_convo.event_match_group_id IS NOT NULL
        THEN coalesce(search_profile.first_name, '')
      ELSE coalesce(search_profile.first_name, '') || ' ' || coalesce(search_profile.last_name, '')
    END`;
  return `EXISTS (
    SELECT 1 FROM conversations search_convo
    WHERE search_convo.id = ${participantAlias}.conversation_id
      AND (
        (search_convo.kind = :listSearchGroupKind
          AND ${foldedTextExpression("coalesce(search_convo.title, '')")} LIKE ${foldedPattern} ESCAPE '\\')
        OR (search_convo.kind <> :listSearchGroupKind
          AND search_convo.is_official = false
          AND EXISTS (
            SELECT 1
            FROM conversation_participants search_other
            JOIN identities search_identity
              ON search_identity.id = search_other.identity_id
            JOIN profiles search_profile
              ON search_profile.user_id = search_other.user_id
            WHERE search_other.conversation_id = search_convo.id
              AND search_other.user_id <> :userId
              AND search_identity.kind = :listSearchProfileIdentityKind
              AND ${foldedTextExpression(displayedPartnerName)} LIKE ${foldedPattern} ESCAPE '\\'
          ))
      )
  )`;
}

/** SQL that holds when the conversation of the seat `participantAlias` is of
 *  kind `:listKind`. */
export function conversationKindPredicate(participantAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM conversations kind_convo
    WHERE kind_convo.id = ${participantAlias}.conversation_id
      AND kind_convo.kind = :listKind
  )`;
}
