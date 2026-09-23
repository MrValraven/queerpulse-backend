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
mailbox. It rewrites member-visible history (see the migration's own doc
comment for the full mechanics), so it may not run until all three blockers
below clear:

1. **The reply-quote floor fix is shipped.** Read paths render a reply's
   quoted parent, and serve its attachment, without checking the reader's own
   `cleared_at`, so a post-floor reply quoting a pre-floor message would show
   that pre-floor message to a co-manager who should not see it. The
   migration's own log counts the exposure (`preFloorQuoteThreadCount`), but
   the fix has to live in the application code.
2. **The frontend renders the `moved_to_business_mailbox` system event.** The
   migration posts one system message per moved thread with that event type.
   Until the frontend has a pill for it, it falls back to the generic system
   event copy ("member left"), which is wrong and confusing for both the
   customer and the co-managers who newly see the thread.
3. **A rehearsal on a copy of production data.** Run this migration's `up()`
   against a copy of the production database and read the `NOTICE`-level
   counts it logs (per `skip_reason`, plus `fallbackFloorCount`,
   `enquiryCoveredCount`, `ownerClearCoveredCount`, `noteBelowStaffFloorCount`,
   `noteAboveEarlierMessageCount` and `preFloorQuoteThreadCount`) before it
   ever touches real data.

As of 2026-09-22, blockers 1 and 2 are implemented in the codebase (the
reply-quote/attachment history-floor enforcement, and the frontend's
`moved_to_business_mailbox` pill); both must be deployed to production before
this migration moves back. Blocker 3 (a rehearsal on a copy of production
data, reading the `NOTICE`-level counts) is still outstanding, so the
migration stays here.

## Moving it back

Once all three blockers clear, move the file back unchanged:

```
mv src/database/pending-migrations/1821260000000-MigrateEnquiryThreadsToListingMailboxes.ts src/migrations/
```

The class and its `name` string must not change (see the repo `CLAUDE.md` on
renaming an applied migration). `src/database/enquiry-migration-sql.spec.ts`
reads the file from this folder; point its path back at `src/migrations` in
the same change so the guard spec keeps covering the file.
