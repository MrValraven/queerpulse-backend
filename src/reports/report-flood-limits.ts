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
 * EVERYTHING IN THIS SECTION DESCRIBES A SIGNED-IN FILING. `POST /reports` is
 * public (PRD-280), and layers 2 and 3 below are keyed on `reporterId`, which
 * is NULL for a signed-out one, so neither binds there. The second half of
 * this file carries the separate, tighter caps that do, and is honest about
 * how much weaker they are.
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
 * The per-subject cap has ONE exemption: a filing whose derived severity is
 * `Emergency` (`outing` / `doxxing`) is never refused by it. The full argument
 * is on `ReportsService.assertReportingWindowIsClear`.
 *
 * The daily cap grants no exemption. It grants a bounded ALLOWANCE instead. An
 * Emergency filing by a reporter who has already reached `REPORT_DAILY_LIMIT`
 * is still accepted, for `REPORT_DAILY_EMERGENCY_ALLOWANCE` further reports in
 * the same window, and the filing after those is refused whatever its reason
 * code says. The distinction is the whole point. An exemption would turn the
 * emergency band into an unbounded filing channel that any account can open by
 * choosing `outing` every time, which is precisely the flood this file exists
 * to bound. An allowance keeps a hard ceiling on what one account can send in
 * a day and spends the room above the cap only on the band the platform
 * commits to answering within the hour.
 *
 * A refusal is never a silent discard. The caller gets a 429 with plain,
 * non-accusatory copy pointing at the Contact form, and the service writes a
 * greppable moderation log line,
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
 * How many FURTHER reports one member may file in the same rolling 24 hours
 * after reaching `REPORT_DAILY_LIMIT`, when the filing's derived severity is
 * `Emergency` (`outing` / `doxxing`).
 *
 * Five, and the number has to clear two bars at once.
 *
 * Small enough that it can never work as a flood channel. Five extra reports
 * in a day cannot bury a target or drown a queue: the argument on the cap
 * above is that thirty already cannot, and this moves the true ceiling from
 * thirty to thirty-five. Spending the allowance is also the most
 * self-defeating way to abuse this form that exists, because every filing that
 * spends it carries the `Emergency` band's one-hour SLA and writes its own
 * bypass log line. It lands in front of a moderator within the hour with a
 * note saying how it got there. An account reaching for `outing` to buy five
 * more reports is asking to be looked at.
 *
 * Large enough for the day it is actually for. Outing rarely lands on a single
 * surface: the same private detail gets posted to a thread, pasted into a
 * couple of messages, put in a profile, repeated in a community. Each of those
 * is a distinct subject carrying its own report, and five leaves room for more
 * surfaces than the per-subject cap of three allows on any one of them. A
 * member who has already filed thirty reports today and is now being outed is
 * having the worst kind of day this product plans for, and the answer to their
 * thirty-first report cannot be "try again tomorrow".
 *
 * Past the allowance an Emergency filing is refused like any other, with copy
 * of its own (`REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE`) pointing at the
 * Contact form, and a log line of its own. A reporter who exhausts even this
 * is worth a moderator's eyes whichever of the two people they turn out to be.
 */
export const REPORT_DAILY_EMERGENCY_ALLOWANCE = 5;

/**
 * The absolute ceiling on reports from one member in `REPORT_DAILY_WINDOW_MS`,
 * whatever reason codes they carry: the daily cap plus the emergency
 * allowance.
 *
 * Derived rather than written down again, so the two numbers above cannot
 * drift from the number actually enforced. This is what `ReportsService`
 * compares an Emergency filing against once the daily cap has been reached.
 */
export const REPORT_DAILY_EMERGENCY_CEILING =
  REPORT_DAILY_LIMIT + REPORT_DAILY_EMERGENCY_ALLOWANCE;

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
 * With one exception, which is where "adds no new information" stops being
 * true: a filing in the `Emergency` band (`outing` / `doxxing`) is let through
 * regardless of this number, and logged as a bypass. `ReportsService.
 * assertReportingWindowIsClear` carries the argument.
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
 *
 * An Emergency filing refused for having spent `REPORT_DAILY_EMERGENCY_ALLOWANCE`
 * reports above the daily cap reports `daily` here as well: it is the daily
 * ceiling binding, and a third label value would fragment a series whose whole
 * job is to show which cap is under pressure. The log line is where the two
 * are told apart, under its own grep handle.
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
 *
 * The urgent-escalation pointer names the Contact form at `/about/contact`,
 * which is the one channel that exists: it is `POST /inquiries`, and every
 * submission lands in the admin intake console for triage. Earlier copy here
 * said to "reach out to a moderator directly", and there is no such route. The
 * product has no member-to-moderator inbox and sends no email, so that sentence
 * sent a member in an urgent situation looking for a door that is not there.
 * All three strings reach the member verbatim (`REPORT_FLOOD_CAP` tells the
 * client this 429 carries platform-authored copy), so what is written here is
 * exactly what somebody reads at the worst possible moment. The path is
 * spelled out rather than linked because these are plain strings on an error
 * body.
 *
 * `REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE` is the one a member reads in the
 * worst circumstances this endpoint can produce: they are filing an emergency
 * report, and even the room kept above the cap for emergencies is spent. It
 * says plainly that the ceiling was reached, confirms that everything already
 * sent is with moderators and being treated as urgent, and hands over the one
 * channel that stays open. It makes no accusation and no promise of a reply,
 * since the product delivers no email.
 */
export const REPORT_DAILY_CAP_MESSAGE =
  'You have filed a lot of reports in the last day. The ones you already sent are with the moderation team. Please try again tomorrow. If something urgent is happening, use the Contact form at /about/contact.';

export const REPORT_DAILY_EMERGENCY_ALLOWANCE_MESSAGE =
  'You have reached the most reports one account can file in a day, including the extra room kept for urgent ones. Everything you have sent is with the moderation team, and the urgent reports are prioritized for review. Please try again tomorrow. If something is still happening right now, use the Contact form at /about/contact and describe it there.';

export const REPORT_PER_SUBJECT_CAP_MESSAGE =
  'You have already reported this a few times recently. Those reports are with the moderation team, so there is no need to send another one. If something urgent is happening, use the Contact form at /about/contact.';

/* ------------------------------------------------------------------------ *
 * The anonymous path (PRD-280)
 * ------------------------------------------------------------------------ */

/**
 * `POST /reports` is PUBLIC. A signed-out person can file, and everything above
 * this line stops binding when they do.
 *
 * Read the three layers again with a NULL `reporterId` in mind and only one of
 * them survives:
 *
 *  1. The burst `@Throttle` still applies, and it is tightened for the
 *    signed-out path (see `REPORT_ANONYMOUS_BURST_LIMIT`).
 *  2. The open-report dedupe does NOT apply, at either level. The partial
 *    unique index is over `reporter_id`, and Postgres treats NULLs as distinct
 *    in a unique index, so no two anonymous rows ever collide. The `findOne`
 *    fast-path is skipped deliberately rather than being made to match on NULL:
 *    matching would hand one stranger another stranger's report back and throw
 *    the second filing away, which is a leak and a silent data loss at once.
 *    `ReportsService.create` carries that argument at the call site. The cost
 *    is that a signed-out double-submit writes two rows, which the caps below
 *    are sized to absorb.
 *  3. The rolling per-MEMBER caps do not apply, because there is no member.
 *
 * So the caps below exist, and they are keyed on the only durable thing a
 * signed-out caller carries: a peppered digest of their network address
 * (`anonymous-reporter-key.ts`, which is blunt about what that is worth).
 *
 * ## They are NOT equivalent to the per-member caps
 *
 * Say it plainly, because the numbers being smaller invites the opposite
 * reading. A member cap is keyed on an account, and an account is scarce here:
 * this platform is invite-only, so getting a second one is a social act with a
 * person's name attached. An address is not scarce. A VPN subscription, a
 * phone's mobile data and a laptop's wifi are three keys before anyone has
 * tried, and a determined flooder rents as many as they like. These caps
 * therefore raise the cost of a sustained anonymous flood and make it visible
 * in the refusal log; they do not close it. What closes it, if it ever
 * happens, is a moderator seeing the log line and a decision above this file's
 * pay grade.
 *
 * They also OVER-bind in the other direction, and the sizes below are chosen
 * for that rather than for the attacker. Carrier-grade NAT puts a large share
 * of a country's mobile traffic behind a small number of addresses, and a
 * queer community centre's wifi puts everyone in the building behind one, so
 * several unrelated genuine reporters can share a key. A refusal on this path
 * is therefore never a dead end: the copy hands over the Contact form at
 * `/about/contact`, which is `POST /inquiries` and is itself open to
 * signed-out visitors.
 *
 * ## Why they are tighter than the member ones anyway
 *
 * Because the anonymous path lost layer 2 as well as layer 3. A member's 30 a
 * day sits on top of a dedupe that collapses repeats; an anonymous 30 would
 * not. And an anonymous filing carries no account a moderator can look at, so
 * a junk one costs more of a human's attention per row than a member's does.
 *
 * For scale: `POST /intakes/:kind` has been fully public all along with an
 * 8/60s IP throttle and NO durable cap at all, so the anonymous report path
 * ends up the STRICTER of the two public write paths this product exposes.
 */

/** The rolling window for the anonymous per-key cap: 24 hours, as for members. */
export const REPORT_ANONYMOUS_DAILY_WINDOW_MS = REPORT_DAILY_WINDOW_MS;

/**
 * How many reports one anonymous key may file across ALL subjects in a rolling
 * 24 hours.
 *
 * Ten, against thirty for a member, and the gap is the missing dedupe plus the
 * missing account. Ten is still well clear of what one shared address plausibly
 * needs: it covers a genuinely bad night for one person and leaves room for
 * two or three unrelated people behind the same carrier NAT to each file a
 * couple of times without ever seeing a refusal. It is a long way below what a
 * flood looks like, which is the number that matters, since the burst
 * throttle's implied ceiling on this path is 5 a minute.
 */
export const REPORT_ANONYMOUS_DAILY_LIMIT = 10;

/**
 * How many FURTHER reports one anonymous key may file in the same rolling 24
 * hours once `REPORT_ANONYMOUS_DAILY_LIMIT` is reached, when the filing's
 * derived severity is `Emergency` (`outing` / `doxxing`).
 *
 * Three, on the identical argument to `REPORT_DAILY_EMERGENCY_ALLOWANCE`: an
 * allowance rather than an exemption, so the emergency band buys bounded room
 * above the cap instead of an unbounded filing channel that any caller can
 * open by choosing `outing` every time. Smaller than a member's five because
 * the ceiling it lifts is smaller, and because it is the cheapest lever on
 * this whole path for somebody with no account to lose.
 *
 * It is kept at all because of who is on the other side of it. The person most
 * likely to file without signing in is somebody who does not have an account
 * and is being outed by a member who does, and "you have reached today's
 * limit" is the wrong answer to that report even at report eleven.
 */
export const REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE = 3;

/**
 * The absolute ceiling on reports from one anonymous key in
 * `REPORT_ANONYMOUS_DAILY_WINDOW_MS`, whatever reason codes they carry.
 *
 * Derived, like `REPORT_DAILY_EMERGENCY_CEILING`, so the two numbers above
 * cannot drift from the number actually enforced.
 */
export const REPORT_ANONYMOUS_DAILY_EMERGENCY_CEILING =
  REPORT_ANONYMOUS_DAILY_LIMIT + REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE;

/** The rolling window for the anonymous per-subject cap: 7 days, as for members. */
export const REPORT_ANONYMOUS_PER_SUBJECT_WINDOW_MS =
  REPORT_PER_SUBJECT_WINDOW_MS;

/**
 * How many reports one anonymous key may file against the SAME subject
 * (`subjectType` + `subjectId`) in a rolling 7 days.
 *
 * Three, the same as a member's, and deliberately NOT tighter even though
 * every other anonymous number is. This is the one cap standing in for the
 * missing dedupe, so it has to absorb what the dedupe used to absorb: a
 * signed-out double-tap on the submit button, or a retry after a flaky
 * connection, writes two real rows here where a member's would have collapsed
 * into one. Cutting this to two would mean an ordinary double-submit spends
 * the whole allowance and the reporter's next genuine filing is refused.
 *
 * It yields to an `Emergency` filing exactly as the member cap does, logged as
 * a bypass, and what bounds it instead is the daily ceiling above.
 */
export const REPORT_ANONYMOUS_PER_SUBJECT_LIMIT = 3;

/**
 * The burst `@Throttle` limit on the signed-out path: 5 a minute against a
 * member's 10, over the same 60-second window.
 *
 * Tighter for the honest reason. On the member path the burst throttle is the
 * layer nobody relies on, because two durable layers sit behind it. On the
 * anonymous path it is one of only two, and it is the only one that binds
 * within the first minute, before enough rows exist for a durable count to
 * refuse anything. Five a minute is far above any human filling in a form,
 * including a distressed one, and it halves what a script gets through before
 * the daily cap starts answering.
 *
 * Both paths key this on client IP through `HttpThrottlerGuard`'s default
 * tracker and both keep their counters in process memory, so this number says
 * nothing about sustained behaviour. That is what the caps above are for.
 */
export const REPORT_ANONYMOUS_BURST_LIMIT = 5;

/**
 * The refusal copy for the anonymous caps.
 *
 * Written for a person with no account, which changes two things about it.
 * There is no `GET /reports/mine` for them to check and no bell to notify
 * them, so the reassurance that what they already sent is with moderators is
 * the only confirmation they will ever get and it has to be unambiguous. And
 * because a shared address means they may be reading a refusal earned by a
 * stranger, it says nothing at all about earlier reports beyond that: not how
 * many, not from whom, not what happened to them. The Contact form is named as
 * the way through, and it is genuinely open to them.
 *
 * No promise of a reply, here or anywhere: QueerPulse delivers no email.
 */
export const REPORT_ANONYMOUS_DAILY_CAP_MESSAGE =
  'A lot of reports have come from this connection in the last day, so this one was not sent. Anything already sent is with the moderation team. Please try again tomorrow, or use the Contact form at /about/contact if something urgent is happening. Signing in lifts this limit.';

export const REPORT_ANONYMOUS_DAILY_EMERGENCY_ALLOWANCE_MESSAGE =
  'This connection has reached the most reports it can send in a day, including the extra room kept for urgent ones, so this one was not sent. Anything already sent is with the moderation team and urgent reports are prioritized. If something is happening right now, use the Contact form at /about/contact and describe it there. Signing in lifts this limit.';

export const REPORT_ANONYMOUS_PER_SUBJECT_CAP_MESSAGE =
  'This has already been reported a few times from this connection recently, so this report was not sent. Those reports are with the moderation team. If something urgent is happening, use the Contact form at /about/contact.';
