import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * A participant's standing in a GROUP thread (feature #17). Every pre-group row
 * and both sides of a DM default to `member`; a group's creator is seeded as
 * `owner`. Phase 1 only SETS this column (creator = owner) — Phase 2 enforces
 * what each role may do (add/remove members, rename, promote/demote).
 */
export enum ConversationRole {
  Owner = 'owner',
  Admin = 'admin',
  Member = 'member',
}

/**
 * PRD-349: the mute MODE, a second axis independent of the `muted` boolean +
 * `mutedUntil` timed expiry (see `muteMode`'s own column doc for exactly how
 * the two interact). `All` is every pre-PRD-349 row and the default for a
 * fresh one; `MentionsOnly` is the new choice offered alongside the 8-hour/
 * 1-week/Always mute durations in the row menu.
 */
export enum ConversationMuteMode {
  All = 'all',
  MentionsOnly = 'mentionsOnly',
}

@Entity('conversation_participants')
@Unique('UQ_conversation_participants', ['conversationId', 'userId'])
export class ConversationParticipant {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_conversation_participants_conversation_id')
  @Column({ type: 'uuid' })
  conversationId!: string;

  @Index('IDX_conversation_participants_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * Which identity this seat speaks for. A member's own threads carry their
   * profile identity. A business thread carries one row per staff member, each
   * with the business identity here, which is what keeps unread, mute, pin,
   * archive and drafts per person while the thread belongs to the mailbox.
   */
  @Index('IDX_conversation_participants_identity_id')
  @Column({ type: 'uuid' })
  identityId!: string;

  /**
   * Group standing. `member` for DMs and every pre-group row; a group creator is
   * `owner`. Set at creation in Phase 1; role-gated actions arrive in Phase 2.
   */
  @Column({
    type: 'enum',
    enum: ConversationRole,
    enumName: 'conversation_participants_role_enum',
    default: ConversationRole.Member,
  })
  role!: ConversationRole;

  /**
   * The owner/admin who removed this participant from a group (`removeMember`),
   * else NULL. Set together with `leftAt` AND `removedAt` on a REMOVAL, left
   * NULL on a voluntary leave. Cleared back to NULL on re-seat (an add or an
   * accepted invite writes a fresh row's worth of state over the old one).
   * `ON DELETE SET NULL`: a remover who later erases their account leaves no
   * dangling reference here, so this column alone is NOT the durable record
   * of a removal (see `removedAt`, which is). Kept for "who did it" display
   * (a moderation/audit trail) even though it cannot anchor DES-227/228's
   * severed-notice copy or the join-by-link removed gate on its own.
   */
  @Column({ type: 'uuid', nullable: true })
  removedBy!: string | null;

  /**
   * When this participant was REMOVED from a group (`removeMember`), else
   * NULL: the durable counterpart to `removedBy`. Unlike `removedBy`, this
   * column carries no FK, so it cannot be nulled out by the remover's own
   * account later being deleted: `computeGroupLeftReason` reads THIS column's
   * mere presence (not `removedBy`'s) to tell "removed" from "left", and
   * `joinByToken`'s REMOVED_FROM_GROUP gate does the same, so a removed
   * member's severed notice stays "You were removed from this group" (never
   * quietly reading back as "You left this group") and a removed member can
   * never rejoin via a stale invite link just because the remover's account
   * is gone. Set together with `leftAt`/`removedBy` on a REMOVAL, left NULL
   * on a voluntary leave, cleared back to NULL on re-seat exactly like
   * `removedBy`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  removedAt!: Date | null;

  /**
   * When this participant LEFT a group. The row is kept (not deleted) so past
   * messages still resolve the member's identity and the system-message history
   * ("Cy left") stays intact. NULL = still an active member. A left member keeps
   * read access to history but is blocked from sending.
   */
  @Column({ type: 'timestamptz', nullable: true })
  leftAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt!: Date | null;

  /**
   * PRD-351: the server clock's own timestamp at the moment `markRead` last
   * ran for this participant, the INSTANT they read, distinct from
   * `lastReadAt` right above. `lastReadAt` is a WATERMARK (the `created_at` of
   * the newest message they were shown, clamped forward-only), and unread
   * counts plus the "seen" ceiling depend on exactly that semantics, so it
   * must never be repurposed to carry a real read time. Written
   * unconditionally on every `markRead` call, ungated by the PRD-364
   * read-receipt-sharing toggle at write time (the toggle withholds
   * `otherLastReadInstant` only at RESPONSE time, the same reciprocal check
   * already applied to `otherLastReadAt`). Never GREATEST-clamped: the exact
   * moment of the LATEST `markRead` call is what this column means. NULL
   * means "never read since this column existed".
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastReadInstant!: Date | null;

  /**
   * Delivered watermark: everything in this conversation created at-or-before
   * this instant has reached this participant's device (they acked receipt over
   * the socket, or fetched/read the thread). One rung below `lastReadAt` — read
   * implies delivered, so `markRead` advances both. Null until the first ack.
   */
  @Column({ type: 'timestamptz', nullable: true })
  deliveredAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  clearedAt!: Date | null;

  /**
   * The privacy floor of a MAILBOX STAFF seat: nothing created at or before
   * this instant exists for this staff member, so its quotes, pins,
   * reactions, stars, attachments, forwards, live frames and reports are
   * withheld too (`mailboxStaffHistoryFloorCoversPredicate`). Written only
   * when a staff member is seated or reseated (`IdentityMailboxSyncService`),
   * together with `clearedAt` and from the same database instant, so the
   * message list hides pre-hire history as well. The one exception is the
   * one-time backfill in `1821500000000-AddConversationParticipantHistoryFloor`
   * (and its documented post-deploy rerun), which copied `clearedAt` into
   * this column on every non-profile seat of a direct, non-official thread,
   * so a staff member's personal clear from before then also counts as a
   * floor. A personal "clear chat"
   * writes `clearedAt` alone: it hides history from this person's own list
   * and leaves every other action on older messages working, as in a
   * personal chat. NULL on every personal and group seat.
   */
  @Column({ type: 'timestamptz', nullable: true })
  historyFloorAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  muted!: boolean;

  /**
   * PRD-349 (mentions-only mute): a SECOND axis on top of `muted`/`mutedUntil`,
   * never a loose boolean that could contradict them. `All` (the default) is
   * the ordinary mute the two columns above already govern: `isParticipantMuted`
   * decides whether a plain "new message" push reaches this participant.
   * `MentionsOnly` OVERRIDES that decision independent of `muted`/`mutedUntil`'s
   * own value: this participant never gets the plain message push, full stop,
   * but a message that `@`-mentions them still reaches them, exactly once (see
   * `PushMessageListener.eligibleMessagePushRecipientUserIds`, which excludes a
   * `MentionsOnly` participant the same way it excludes a fully muted one, so
   * they fall through to the separate mention-notification push path instead of
   * the merged "new message" one). Picking "Mentions only" from the row menu
   * stands alongside the 8-hour/1-week/Always mute durations as its own
   * distinct choice, so it does not itself touch `muted`/`mutedUntil`; a
   * participant could in principle carry `muted: true` (from an earlier ordinary
   * mute) alongside `muteMode: 'mentionsOnly'`; the mentions-only override still
   * wins for push purposes either way, which is why `eligibleMessagePushRecipientUserIds`
   * checks this column unconditionally rather than only when `muted` is false.
   */
  @Column({
    type: 'enum',
    enum: ConversationMuteMode,
    enumName: 'conversation_participants_mute_mode_enum',
    default: ConversationMuteMode.All,
  })
  muteMode!: ConversationMuteMode;

  /**
   * When a TIMED mute (PRD-349: 8 hours / 1 week) expires. NULL means either
   * "not muted" (when `muted` is false) or "muted forever" (when `muted` is
   * true and this is NULL, the pre-PRD-349 shape, and the "Always" choice);
   * there is no separate forever sentinel. Once past, the mute is a stale
   * timed grant: `isParticipantMuted` below treats it as already expired
   * without a background job ever clearing the row, and the next write that
   * touches this participant (`ConversationsService.setMuted`, or the
   * inbox-list read in `ConversationsService.listConversations`) lazily
   * clears both columns back to unmuted, so a lingering expired row can't
   * strand `muted = true, mutedUntil <in the past>` forever. Any reader that
   * cannot afford to wait for that lazy clear (e.g. a query builder's `WHERE`
   * clause) should use `notCurrentlyMutedPredicate` below instead of a bare
   * `muted = false` column check.
   */
  @Column({ type: 'timestamptz', nullable: true })
  mutedUntil!: Date | null;

  /**
   * When this participant PINNED the conversation to the top of their own inbox.
   * A per-participant preference (like `muted`), stored as a timestamp — not a
   * boolean — so pins sort deterministically (most-recently-pinned first) and it
   * matches the other watermark columns above. NULL = not pinned. Capped at 3
   * pinned conversations per user, enforced in `ConversationsService.setPinned`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  pinnedAt!: Date | null;

  /**
   * When this participant FAVORITED the conversation. A per-participant
   * preference (like `muted`), stored as a timestamp for the same reasons as
   * `pinnedAt`. NULL = not favorited.
   */
  @Column({ type: 'timestamptz', nullable: true })
  favoritedAt!: Date | null;

  /**
   * When this participant ARCHIVED the conversation out of their main inbox.
   * A per-participant preference (like `muted`/`pinnedAt`), stored as a
   * timestamp so it could sort ("most recently archived first") if the
   * Archived tab ever wants that. NULL = not archived.
   *
   * Auto-cleared (unarchived) the instant a genuinely NEW message lands in
   * the conversation — see `MessagingCoreService.buildPostResult` — so an
   * archived thread can never silently swallow a reply the way a
   * `deletedAt`-style hard clear could. This is the intended replacement for
   * "clear for me" (`clearedAt`) as the everyday way to declutter the inbox:
   * reversible, and it resurfaces itself the moment the conversation is
   * live again. `clearedAt` itself is untouched — it keeps its own,
   * separate, still-destructive "delete for me" meaning.
   */
  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  /**
   * When this participant explicitly MARKED the conversation unread from the
   * inbox row menu (PRD-225) — a WhatsApp/Telegram/Signal-style "come back to
   * this" flag, independent of `lastReadAt`. Stored as a timestamp (like
   * `pinnedAt`/`favoritedAt`/`archivedAt`) so it is server state that survives
   * navigating away and shows up on this member's other devices. NULL = not
   * manually marked unread.
   *
   * Deliberately NOT derived from (or written by) `markRead`'s GREATEST-only,
   * forward-moving watermark logic — a manual mark-unread cannot walk
   * `lastReadAt` backward, so it needs its own column. It is cleared back to
   * NULL ONLY by `ConversationsService.markRead` (i.e. genuinely re-opening
   * and reading the thread again), never by an inbox refetch or an unrelated
   * preference toggle, so it can't be silently undone by a re-render.
   */
  @Column({ type: 'timestamptz', nullable: true })
  markedUnreadAt!: Date | null;

  /**
   * This participant's unsent composer text for the conversation, synced from
   * the client so it survives a device switch (phone -> laptop) — the
   * cross-device layer on top of the instant, always-on localStorage copy the
   * composer itself writes on every keystroke (`features/messages/drafts.ts`).
   * Debounced on the client (`PATCH /conversations/:id { draft }`); NULL/empty
   * once the draft is sent or explicitly cleared. Never broadcast over the
   * realtime socket — it is this participant's own unsent text, nobody else's
   * concern, and reading it back only ever happens on this participant's own
   * `GET /conversations`.
   */
  @Column({ type: 'text', nullable: true })
  draft!: string | null;
}

/**
 * THE single definition of "is this participant CURRENTLY muted" (PRD-349):
 * TRUE only while `muted` is set AND, for a TIMED mute, `mutedUntil` has not
 * yet passed. `mutedUntil === null` while `muted` is true means "muted
 * forever", so it never expires on its own. Every reader that gates on mute
 * state (push delivery, the conversation-menu "Muted until {time}" label)
 * must go through this, never re-derive `participant.muted` alone, so an
 * expired timed mute can't keep silencing a member after its clock ran out,
 * even before the lazy DB clear described on `mutedUntil` above gets a
 * chance to run. `now` is injectable (default `new Date()`) purely for tests.
 */
export function isParticipantMuted(
  participant: Pick<ConversationParticipant, 'muted' | 'mutedUntil'>,
  now: Date = new Date(),
): boolean {
  if (!participant.muted) return false;
  if (!participant.mutedUntil) return true;
  return participant.mutedUntil.getTime() > now.getTime();
}

/**
 * PRD-349: TRUE for a participant who must NEVER receive the PLAIN "new
 * message" push: either an ordinary current mute (`isParticipantMuted`) OR
 * `muteMode: 'mentionsOnly'`, checked unconditionally (see `muteMode`'s own
 * column doc for why the mentions-only override does not require `muted` to
 * be false first). `PushMessageListener.eligibleMessagePushRecipientUserIds`
 * is the one caller: excluding a mentions-only participant here, the same way
 * a fully muted one already was, is what lets them fall through to the
 * separate `@`-mention push path instead (`PushNotificationListener
 * .pushMention`) rather than getting the merged plain/mention message push,
 * so a message that mentions them still reaches them, exactly once, while an
 * ordinary message from the same thread never does.
 */
export function isMutedForPlainMessagePush(
  participant: Pick<
    ConversationParticipant,
    'muted' | 'mutedUntil' | 'muteMode'
  >,
  now: Date = new Date(),
): boolean {
  return (
    isParticipantMuted(participant, now) ||
    participant.muteMode === ConversationMuteMode.MentionsOnly
  );
}

/**
 * SQL-fragment counterpart to `isParticipantMuted`, for a TypeORM
 * `QueryBuilder` `.andWhere(...)`: a plain object `find({ where: { muted:
 * false } })` can't express "OR a timed mute that has already expired" (see
 * `isParticipantMuted`'s own doc for why a stale `muted = true` row can't be
 * trusted alone). `alias` is the query's participant-table alias (e.g. `'p'`
 * for `p.muted`/`p.muted_until`). Evaluates TRUE for a participant that is
 * NOT currently muted, i.e. safe to notify/push.
 */
export function notCurrentlyMutedPredicate(alias: string): string {
  return `(${alias}.muted = false OR (${alias}.muted_until IS NOT NULL AND ${alias}.muted_until <= now()))`;
}
