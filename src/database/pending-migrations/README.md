# Pending migrations

Migrations that sit here, outside `src/migrations`, are excluded from every
migration run: `src/data-source.ts` (the TypeORM CLI) and
`src/database/database.module.ts` (the app, including the boot-time
`ensureDatabaseSchema` catch-up) both glob `src/migrations/*.ts` only, so a
file in this folder is invisible to `migration:run`, `migration:run:prod` and
the deploy preflight. That is the point: a migration lands here when it is
ready for review but must not run on the next deploy.

## `1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts`

Moves every existing listing-enquiry thread into its listing's business
mailbox, splitting it at the enquiry. It rewrites member-visible history (see
the migration's own doc comment for the full mechanics), so it may not run
until all three blockers below clear.

The split instant is the thread's earliest enquiry anchor. A thread with no
message before that instant is rekeyed in place: the owner's seat speaks for
the listing, active co-managers are seated with no `cleared_at`, the owner's
replies are re-attributed to the listing, and `pair_key` becomes the
customer-and-listing pair. A thread with earlier messages is split: a new
business conversation takes every message from the split instant on, with
its pins and its `listing_enquiries` rows, and seats the customer, the owner
(as the listing) and the co-managers. Everything before the enquiry stays in
the personal DM between the customer and the owner, so co-managers never see
it and a later handover or business block leaves it untouched. A thread
with no message at or after the split instant has nothing to move and stays
personal (skip reason `nothing_to_move`).

Each moved thread gets one `moved_to_business_mailbox` note at the top of its
business thread. The migration records every moved thread in a bookkeeping
table, `enquiry_mailbox_moves`, which `down()` reads to reverse both shapes
(messages, pins and enquiries move back, the business conversation and its
seats are deleted, the notes are removed, sender identities and reply-gate
columns are restored) and then drops. `reply_to_id` is left intact: a moved
reply quoting a message that stayed personal renders as unavailable through
the reply-quote guard in blocker 1. The bookkeeping table holds member ids
with no foreign key, so once the move is confirmed permanent a follow-up
migration drops `enquiry_mailbox_moves`, after which this migration's
`down()` is no longer available.

1. **The same-conversation reply-quote guard is deployed.** The sibling
   change in `src/messaging/messaging-core.service.ts` makes the reply-quote
   loader render a parent that lives in another conversation as unavailable.
   Without it, a moved reply quoting a pre-enquiry message would show that
   private message to co-managers. The migration's log counts these replies
   (`crossSplitReplyCount`).
2. **The frontend renders the `moved_to_business_mailbox` system event.** The
   migration posts one system message per moved thread with that event type.
   Until the frontend has a pill for it, it falls back to the generic system
   event copy ("member left"), which is wrong and confusing for both the
   customer and the co-managers who newly see the thread.
3. **A rehearsal on a copy of production data.** Run this migration's `up()`
   against a copy of the production database and read the counts it prints
   with `console.log`, one JSON row per outcome (`moved` or a skip reason,
   each with its `threadCount`), plus `rekeyedThreadCount`,
   `splitThreadCount`, `movedMessageCount`, `crossSplitReplyCount` and
   `fallbackAnchorCount`, before it ever touches real data.

Co-managers on a moved thread are seated with no floor. Every co-manager
active when this migration runs sees the whole business part from the
enquiry onward, including messages sent before they accepted the co-manager
invite (their `listing_co_managers.accepted_at`). A live hire is floored at
its accept instant, so this is wider than what a hire gets today. It is
accepted because no pre-enquiry DM history reaches a co-manager, and
flooring each one at `accepted_at` would need `history_floor_at`, which
`1821500000000` adds and which runs after this migration on a fresh
database.

Order against `1821500000000-AddConversationParticipantHistoryFloor.ts`: that
migration's backfill must already be applied in production before this one
runs, so every existing staff floor is in place when new staff seats appear.
On an empty development database the order does not matter, because this
migration writes no floor and never names the column that one adds. On a
development database with data, run `1821500000000` there before moving
this file back: if this migration runs first, the backfill afterwards
treats the owner's own `cleared_at` on a rekeyed owner seat and the owner
clear copied onto a split thread's business seat as staff floors. That errs
private, but it hides quotes, pins and reactions on those rows from the
owner. If that already happened on a development database, set
`history_floor_at` back to NULL on the seat of each `owner_user_id` in its
`business_conversation_id`, both read from `enquiry_mailbox_moves`.

As of 2026-09-23, blockers 1 and 2 are implemented in the codebase (the
same-conversation reply-quote guard in
`src/messaging/messaging-core.service.ts` and the frontend's
`moved_to_business_mailbox` pill); both must be deployed to production
before this migration moves back. Blocker 3 (a rehearsal on a copy of
production data) is still outstanding, so the migration stays here.

## Moving it back

Once all three blockers clear, move the file back unchanged:

```
mv src/database/pending-migrations/1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts src/migrations/
```

The class and its `name` string must not change (see the repo `CLAUDE.md` on
renaming an applied migration). `src/database/enquiry-migration-sql.spec.ts`
reads the file from this folder; point its path back at `src/migrations` in
the same change so the guard spec keeps covering the file.

## `1821700000000-RerunRepairOrphanedPersonaCreators.ts`

A second run of the orphaned-persona repair that
`1821500400000-RepairOrphanedPersonaCreators.ts` applies with the persona
creator handoff. Both run the same SQL, the constant
`REPAIR_ORPHANED_PERSONA_CREATORS_SQL` in
`src/database/repair-orphaned-persona-creators.sql.ts`, and both log its
counts. An orphaned persona is one whose creator (`subprofiles.user_id`) has
no `subprofile_members` row while other members exist; the repair hands each
one to a remaining co-owner.

Why a second run: migrations apply before the handoff release takes traffic,
so the previous release keeps serving requests for a while after
`1821500400000` commits. During that deploy window it can orphan a persona
again from two sources:

1. **A creator leaves under the old release.** The previous release's
   `leave()` deletes the creator's member row and keeps the creator column.
2. **A stale whole-entity save.** The previous release's `update`, `publish`
   and `unpublish` save the whole persona row. An edit that loaded the
   persona before the repair committed and saves after it writes the
   pre-repair creator and slug back over the successor.

The repair's orphan predicate catches both. Once the handoff release is the
only one serving traffic, neither source exists any more, so one rerun closes
the window. Until the rerun, a persona orphaned in the window stays orphaned:
its successor has no creator powers, and nobody can delete or unpublish it or
remove its members. The rerun is idempotent, so on a database with no orphan
it changes nothing and logs zero counts. Like the first run it sends no
notification, and mailbox seats follow on the next hourly reconciliation
sweep.

### Moving it into `src/migrations`

Move it in the release AFTER the one that ships the handoff (the release that
carries `1821500400000`). Moving it in the same release would run it in the
same deploy window as the first run, which is exactly the window it exists to
clean up after.

```
mv src/database/pending-migrations/1821700000000-RerunRepairOrphanedPersonaCreators.ts src/migrations/
```

In the same change, update its import of the repair constant from
`'../repair-orphaned-persona-creators.sql'` to
`'../database/repair-orphaned-persona-creators.sql'`, which is the path
`1821500400000` uses. Keep the class name and its `name` string. The
timestamp can stay as it is even if later migrations land first: TypeORM
0.3.30 runs every unapplied migration regardless of order (its out-of-order
check is commented out in `MigrationExecutor`), and this rerun depends on no
schema added after `1821500400000`. Renumbering is optional; if you do it,
rename the file, the class and the `name` string together, and update the
comments that name `1821700000000` (`repair-orphaned-persona-creators.sql.ts`,
`notification.entity.ts`, `notification-preferences.ts`,
`notifications.listener.ts`) in the same change.

The SQL constant is frozen with both migrations (see the header of
`repair-orphaned-persona-creators.sql.ts`): do not edit it to change what the
rerun does.

### Running it by hand instead

If the rerun cannot wait for the next release, run the same SQL once against
production after the handoff release is live and serving all traffic, and
then delete this file instead of moving it. From the backend root, after
`pnpm build` (the constant compiles to
`dist/database/repair-orphaned-persona-creators.sql.js`):

```
node -e "process.stdout.write(require('./dist/database/repair-orphaned-persona-creators.sql').REPAIR_ORPHANED_PERSONA_CREATORS_SQL)" | psql "$DATABASE_URL" -v ON_ERROR_STOP=1
```

It runs as one statement and applies all or nothing. It prints its counts as
a NOTICE; on a database with no orphan the line reads
`orphaned persona repair: repaired 0, history rows 0, slugs suffixed 0, moderation rows copied 0, skipped {}`.
If it aborts with a deadlock (a concurrent account erasure), run it again.
Always pipe the compiled constant: the source file interpolates the tally
setting's name into the SQL, so the text in the `.ts` file cannot be pasted
into psql as it stands.
