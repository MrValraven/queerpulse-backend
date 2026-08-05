# Pending migrations — apply checklist

**Generated:** 2026-08-05 · **Scope:** `queerpulse-backend/src/migrations`

Tracks migrations authored during the recent feature builds that have **not yet
been applied** anywhere (dev/staging/prod verification still open). Cross-refs
audit item **P1-10** in
`../../queerpulse/docs/production-readiness/PLATFORM-GAPS-TRACKER-2026-08-04.md`
("~20 unapplied migrations — product code reads columns the live schema may
lack; verify prod DB state — could be P0 there").

> The schema is migration-owned (`synchronize` is never enabled). Every row
> below adds schema the product code already expects, so **an environment that
> is missing these will 500 / return wrong data** on the matching feature until
> they run.

## How to apply

```bash
# Confirm what the target DB thinks is pending first (source of truth):
pnpm run typeorm migration:show

# Dev (ts-node) — applies the WHOLE pending batch in timestamp order:
pnpm run migration:run

# Prod (compiled dist) — deploy order is always migrate → start:
pnpm run migration:run:prod
```

A single `migration:run` is safe for this whole batch. `src/data-source.ts` sets
`migrationsTransactionMode: 'each'` (one transaction per migration), so the
`CREATE INDEX CONCURRENTLY` migrations below — which set `transaction = false` —
self-opt-out of a transaction and run correctly inline with the transactional
ones. No manual splitting is required.

### CONCURRENTLY / non-transactional note (two-phase runbook)

Five migrations build indexes with `CREATE INDEX CONCURRENTLY` and therefore run
**outside a transaction** (`transaction = false`, honoured by the `each` mode
above). Implications for the maintainer:

- A partial failure is **not rolled back** — a failed `CONCURRENTLY` build can
  leave an `INVALID` index. Each of these migrations' `down()` uses
  `DROP INDEX CONCURRENTLY`, so re-running after a drop is safe; if one fails
  mid-flight, drop the invalid index and re-run that migration alone:
  `pnpm run typeorm migration:run -- --transaction none`.
- The mixed transactional-DDL + `CONCURRENTLY` two-phase split from the runbook
  is **not** needed here: none of these files mixes a schema rewrite with a
  concurrent index in the same migration — the concurrent ones are index-only.
- These build without an `ACCESS EXCLUSIVE` table lock, so they are the ones you
  can run against a live, loaded table without blocking writers.

The five: `AddListingCoordinatesIndex`, `AddListingNameSearchIndex`,
`AddReasonCodeToReportsOpenDedupeIndex`, `AddReportsSubjectTypeCreatedAtIndex`,
`AddCoopJoinRequestsCoopCreatedAtIndex`.

## Checklist (timestamp order — 20 migrations)

- [ ] **1785800501000 · CreateMagazineDecks** — new `magazine_deck` table (jsonb
      slides, nullable `published_at`); unique index on `slug`, index on
      `published_at`. Backs the slide-deck magazine reader/authoring.
- [ ] **1785800600000 · AddCommunityArchivedAt** — `archived_at` column on
      `communities`. Metadata-only `ADD COLUMN` (transactional).
- [ ] **1785800700000 · AddListingDrafts** — new `listing_drafts` table +
      `(user_id, updated_at DESC)` index + FK to user. Cross-device
      list-a-business drafts.
- [ ] **1785801000000 · RewriteListingHoursToIntervals** — data migration
      rewriting listing opening-hours to the interval shape. Transactional DML.
- [ ] **1785801100000 · AddListingCoordinatesIndex** — `CONCURRENTLY` index on
      `listings` coordinates. ⚠️ non-transactional (see note).
- [ ] **1785855956158 · AddUserStaffRoles** — new `user_staff_roles` table
      (varchar role: `magazine_editor` / `magazine_writer`) assignable on top of
      tier. Every hosting module must register the `UserStaffRole` repo.
- [ ] **1785900000000 · AddModerationOutcomeNotificationType** —
      `ALTER TYPE "notifications_type_enum" ADD VALUE 'moderation_outcome'`.
      (Duplicate timestamp with `AddRoadmapAdminModel` — harmless; leave it.)
- [ ] **1785900000000 · AddRoadmapAdminModel** — extends `roadmap_items`: adds
      `backlog` column-enum value + new `priority` / `confidence` / `paid_kind` /
      `cost` enums and their columns (`public_note`, `target_quarter`,
      `committed`, `is_public`, `notified`, `spike_flag`, …). Admin roadmap.
- [ ] **1785901000000 · AddForumThreadTags** — `tags` array column on
      `forum_thread` + GIN index. Transactional.
- [ ] **1785901100000 · AddForumOpDenormalization** — denormalized OP
      vote-count / last-activity columns on `forum_thread` + two ordering
      indexes (`op_vote_count DESC,id`; `last_activity_at DESC,id`).
      Transactional.
- [ ] **1785902000000 · CreateListingModerationEvents** — new
      `listing_moderation_events` table + action enum + listing/actor indexes +
      FK. Moderation-console history trail.
- [ ] **1785902100000 · CreateListingQuestions** — new `listing_questions`
      table + listing/asker indexes + FK. Listing Q&A threads.
- [ ] **1785902200000 · AddListingNameSearchIndex** — `CONCURRENTLY` trigram
      index on `listings.name`. ⚠️ non-transactional (see note).
- [ ] **1785902300000 · AddReasonCodeToReportsOpenDedupeIndex** — rebuilds the
      open-report dedupe UNIQUE index to include `reason_code`, via
      `DROP`/`CREATE UNIQUE INDEX CONCURRENTLY`. ⚠️ non-transactional (see note).
- [ ] **1785903000000 · AddReportsSubjectTypeCreatedAtIndex** — `CONCURRENTLY`
      index on `reports (subject_type, created_at)`. ⚠️ non-transactional.
- [ ] **1785903100000 · AddCoopJoinRequestsCoopCreatedAtIndex** — `CONCURRENTLY`
      index on `coop_join_requests (coop_id, created_at)`. ⚠️ non-transactional.
- [ ] **1785903200000 · AddLandingFeature** — new `landing_feature` table
      (jsonb copy) + unique `(section, target_id)` + `(section, active,
      position)` index. Admin-curated live homepage.
- [ ] **1785903300000 · AddProfileFeaturedConsent** — `featured_consent` column
      on `profile` (public opt-in to being featured on the landing page).
- [ ] **1785903400000 · AddEventCommunityId** — `community_id` column + index on
      `events`. Ties events to a community.
- [ ] **1785903500000 · AddForumThreadCommunityId** — `community_id` column +
      index on `forum_thread`. Ties threads to a community.

### Phase 2 wave A (added 2026-08-05)

- [ ] **1786000100000 · CreateCollections** — new `collection` + `collection_item`
      tables (owner-scoped named collections of saved items), indexes on
      `owner_id` / `collection_id`, unique `(collection, kind, subject_id)`.
- [ ] **1786000400000 · AddMemberModerationFields** — `verified_at` + `verified_by`
      (FK→users, ON DELETE SET NULL) on `profiles`. Accountability trail for
      admin Verify.
- [ ] **1786000600000 · AddReadingGroupProposalStatus** — new
      `reading_group_proposal_status_enum` + `status`/`decided_at`/`decided_by`/
      `decision_note` columns (default `pending` backfills existing rows).
- [ ] **1786000700000 · AddGovernanceOverviewPublishedAt** — nullable
      `published_at` on the governance overview singleton (report publish).
- [ ] **1786000800000 · CreateEventBookmarks** — new `event_bookmarks` table
      (user/event FKs ON DELETE CASCADE, composite UNIQUE `(user_id, event_id)`,
      `event_id` index). Backs saved/bookmarked events.
- [ ] **1786000900000 · AddNotificationsTypeIndex** — `CONCURRENTLY` composite
      index on `notifications (user_id, type, created_at DESC)` for the @-mentions
      inbox. ⚠️ non-transactional (see note).

### Phase 3 (added 2026-08-05)

- [ ] **1786001000000 · CreateSafeSpaceNominations** — new `safe_space_nominations`
      table (nominator FK, place fields, status, indexes on status/nominator).
- [ ] **1786001100000 · CreateTopicFollows** — new `topic_follows` table
      (user FK, topic_slug, UNIQUE(user_id, topic_slug), user_id index).
- [ ] **1786001200000 · CreateNewsletterSubscriptions** — new
      `newsletter_subscriptions` table (email UNIQUE, status, confirm_token index).
- [ ] **1786001300000 · CreateInquiries** — new `inquiries` table (contact/partner
      form submissions) + `status` index.
- [ ] **1786001400000 · CreateIntakeSubmissions** — new `intake_submissions` table
      (kind, nullable submitter FK ON DELETE SET NULL, jsonb payload, indexes).
- [ ] **1786001500000 · AddMemberEventSettings** — `default_event_visibility` +
      `event_emails_enabled` columns on `member_event_reminder_preferences`.
- [ ] **1786001600000 · AddEventUpdatedNotificationType** — `ALTER TYPE
      notifications_type_enum ADD VALUE 'event_updated'`. ⚠️ non-transactional
      (enum ADD VALUE cannot run in a transaction; `transaction = false`). Run alone.

## Maintainer sign-off

- [ ] `pnpm run typeorm migration:show` reviewed against this list on **prod**.
- [ ] Batch applied to **staging**; matching features smoke-tested.
- [ ] Batch applied to **prod** (migrate → start deploy order).
- [ ] Any `INVALID` concurrent index checked for (`\d+` in psql) and none found.
- [ ] This file deleted or trimmed once the batch is fully applied everywhere.
