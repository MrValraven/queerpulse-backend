/**
 * The rolling caps that close report flooding as a harassment vector (TS-05).
 *
 * ONE PLACE, ON PURPOSE, in the style of `membership/join-request-sla.ts`.
 * Change a constant here and the service enforcement, the refusal copy and the
 * moderation log line all move together. Nothing else in the codebase should
 * hard-code a report-filing ceiling.
 *
 * ## The three layers on `POST /reports`
 *
 * Filing a report passes through three independent guards. They answer three
 * different questions, so all three are needed.
 *
 * 1. **The 60-second burst throttle.** `@Throttle({ limit: 10, ttl: 60s })` on
 *    `ReportsController.create`, served by the app-wide `HttpThrottlerGuard`.
 *    It stops a script hammering the endpoint. It is the weakest of the three:
 *    it keys on client IP (so a shared network shares one bucket), it stores
 *    its counters in process memory (so they reset on every deploy), and a
 *    burst window says nothing about sustained behaviour. Ten a minute is
 *    14,400 a day.
 *
 * 2. **The open-report dedupe.** A partial unique index,
 *    `UQ_reports_open_reporter_subject` on
 *    (reporter, subjectType, subjectId, reasonCode) `WHERE status = 'open'`,
 *    plus the matching `findOne` fast-path in `ReportsService.create`. It makes
 *    a double-submit idempotent and keeps identical rows off the moderators'
 *    desk. It is deliberately partial: a recurrence after a resolution is worth
 *    surfacing again. That is also its limit as an anti-abuse measure, because
 *    every time a moderator closes a case the door reopens.
 *
 * 3. **The rolling caps below.** The durable rule, read straight off the
 *    `reports` table, so it survives deploys and is per MEMBER rather than per
 *    IP. It is what actually bounds the two sustained shapes: spraying reports
 *    across many subjects to bury a target or drown the queue, and re-filing
 *    against one subject every time their previous report is closed.
 *
 * Both caps count rows regardless of `status`. A resolved or escalated report
 * still spends its slot, deliberately: counting only open rows would mean a
 * moderator clearing the queue hands the allowance straight back, which is the
 * exact loop these caps exist to break.
 *
 * A refusal is never a silent discard. The caller gets a 429 with plain,
 * non-accusatory copy, and the service writes a greppable moderation log line,
 * because a member hitting these numbers is either being harassed at scale or
 * is doing the harassing, and both are worth a moderator's eyes.
 */

/** The rolling window for the platform-wide per-reporter cap: 24 hours. */
export const REPORT_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How many reports one member may file across ALL subjects in a rolling 24
 * hours.
 *
 * Thirty is chosen to sit far above any genuinely bad day and far below a
 * flood. Filing thirty separate reports inside one day already means finding
 * thirty distinct things wrong on the platform in a single sitting, which is a
 * volume no ordinary member reaches even during a brigading wave: the sensible
 * response to a brigade is one report naming the thread, plus a block, and the
 * queue is worked by people, so a thirty-first item from the same reporter adds
 * nothing a moderator cannot already see. The burst throttle's implied ceiling
 * is 14,400 a day, so this is the number that actually binds.
 *
 * It is a ceiling on abuse. Everyday use should never come within sight of it,
 * and a member who does trip it is surfaced to a moderator rather than quietly
 * cut off.
 */
export const REPORT_DAILY_LIMIT = 30;

/**
 * The rolling window for the per-subject cap: 7 days.
 *
 * Longer than the daily window on purpose. The shape this catches is a
 * reporter re-filing against one person each time a case against them is
 * closed, and moderation turnaround is measured in days, so a 24-hour window
 * would let exactly that loop run.
 */
export const REPORT_PER_SUBJECT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How many reports one member may file against the SAME subject
 * (`subjectType` + `subjectId`) in a rolling 7 days.
 *
 * Tighter than the daily cap because this is the actual harassment shape.
 * Three still leaves room for honest use: the open-report dedupe already
 * collapses same-reason duplicates, so reaching three means either three
 * genuinely different reasons on one subject, or two prior cases a moderator
 * has already closed. Past that point the pattern itself is the thing a
 * moderator needs to see, and a fourth row on the same subject adds no new
 * information to the queue.
 *
 * Counted on the subject exactly as filed. Resolving a subject to its OWNER
 * stays out of scope here: `subjectId` is a `varchar` addressed differently per
 * domain (uuid for messages, slug for members and communities, content id for
 * posts and replies), so mapping one to a person means a per-domain lookup for
 * every historical row in the window, on a path that runs on every filing.
 *
 * That leaves TWO known bypasses of this cap. Both are bounded by the daily cap
 * above, and neither is closed here:
 *
 *  1. **Many subjects, one target.** A reporter files against many distinct
 *     subject ids belonging to the same person, for instance one message id per
 *     message. Each is a fresh subject, so each gets its own allowance of three.
 *
 *  2. **A renamed subject.** For `member`, `community` and `housing` subjects
 *     the `subjectId` IS a slug. When the subject changes their handle, every
 *     prior report stays keyed to the OLD slug, so the count against the new
 *     one starts at zero and the reporter gets three more. Cheaper to trigger
 *     than (1), though it needs the TARGET to rename rather than the reporter
 *     to act, which makes it a poor tool for deliberate harassment and more of
 *     an accidental reset.
 *
 * `handle_history` does NOT close (2). That table is a reservation ledger
 * rather than a rename audit trail: `name` is its primary key so only the
 * latest release per name survives, `HandlesService` DELETES the row when a
 * name is reclaimed, and reservations lapse after their cooldown. Former slugs
 * for a given member are therefore not reliably enumerable from it. A real fix
 * means resolving each subject to a stable id at filing time and STORING it, so
 * a new column, a migration, a backfill that cannot resolve already-renamed or
 * deleted subjects, and a resolver for each of the twenty-plus subject types.
 * That is a much larger change than the hole justifies, and it is written down
 * here rather than done.
 */
export const REPORT_PER_SUBJECT_LIMIT = 3;

/**
 * The machine-readable discriminator on a cap refusal's body.
 *
 * ONE code for BOTH caps, deliberately. A client needs exactly one thing from
 * it: whether this 429 carries platform-authored copy that a member should
 * read. Which of the two caps was hit changes only the wording, and the
 * wording is already in `message`. The body also carries an additive `cap`
 * field ("daily" or "subject") for anyone who wants the distinction; nothing is
 * required to read it.
 *
 * This exists because `POST /reports` can answer 429 from two very different
 * places. `@nestjs/throttler`'s burst refusal is thrown with a STRING body, so
 * Nest's default handling ships it with no `code` at all, and its `message` is
 * a framework exception string that no member should ever be shown. A cap
 * refusal from this module is thrown with an OBJECT body carrying this code,
 * which `AllExceptionsFilter` preserves verbatim while filling in the envelope.
 * The presence of the code is therefore the whole test, and no client has to
 * pattern-match English prose to run it.
 *
 * Field name and SCREAMING_SNAKE value follow the established convention for a
 * typed refusal here: `INVITE_QUOTA_EXCEEDED` (`membership/invites.service.ts`,
 * the closest precedent since it is also a quota), `PERK_LEVEL_NOT_REACHED`,
 * `BANNED_FROM_COMMUNITY`, `RULES_ACCEPTANCE_REQUIRED`, `PLATFORM_LOCKED`.
 */
export const REPORT_FLOOD_CAP_CODE = 'REPORT_FLOOD_CAP';

/**
 * Which of the two caps a refusal came from.
 *
 * ONE vocabulary for all three consumers, so they cannot drift: the additive
 * `cap` field on the 429 body, the `cap=` key in the moderation log line, and
 * the `cap` label on the `moderation_report_flood_refusals_total` counter. A
 * spike on the dashboard and the 429 a member saw therefore name the same
 * thing in the same words.
 */
export type ReportFloodCap = 'daily' | 'subject';

/**
 * The refusal copy for each cap.
 *
 * Deliberately non-accusatory and deliberately uninformative about the earlier
 * reports. The member is told that what they already sent is with moderators
 * and nothing more: whether those reports were acted on, dismissed or are still
 * open is moderation business, and echoing it back here would turn this
 * endpoint into an oracle for probing what happens to a target.
 */
export const REPORT_DAILY_CAP_MESSAGE =
  'You have filed a lot of reports in the last day. The ones you already sent are with the moderation team. Please try again tomorrow, and reach out to a moderator directly if something urgent is happening.';

export const REPORT_PER_SUBJECT_CAP_MESSAGE =
  'You have already reported this a few times recently. Those reports are with the moderation team, so there is no need to send another one. Reach out to a moderator directly if something urgent is happening.';
