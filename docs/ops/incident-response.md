# Incident Response

**Status:** OB-03. The process for declaring, running, communicating and
reviewing a production incident.

**Why this exists.** QueerPulse already has the tooling to **communicate** an
incident: a status-incident table, an admin authoring desk, and a public page a
locked-out member can read. What it did not have was a process to **declare**
one, so a real outage depended on whoever noticed deciding, alone and at speed,
whether it was worth writing up. This document is that missing half.

**Related:** `docs/ops/backup-restore.md` (the data-loss playbook),
`docs/ops/breach-notification.md` (when an incident is also a personal data
breach), `docs/ops/no-mailer-at-launch.md` (why the channels are what they are).

---

## 0. Roles

| Role | Who | When |
|---|---|---|
| **Incident commander** | `[OWNER: primary name and contact to be filled in]` | Any declared incident. One person, named out loud, for the whole incident. |
| **Deputy incident commander** | `[OWNER: name and contact to be filled in]` | Whenever the primary is unreachable within the response expectation in §2. |
| **Communications** | `[OWNER: name and contact to be filled in]` | Writes and publishes the status posts. May be the commander on a small incident. |
| **On-call rota** | `[OWNER: rota, or an explicit statement that there is no rota]` | See §4: there is no paging today, so this is a habit rather than an alert. |

**Who may declare an incident:** anyone. A member of the community, a moderator,
a contributor. Declaring costs a status post that can be resolved in ten minutes.
Not declaring costs members sitting in the dark wondering whether they have been
banned.

**Who may publish a status post:** any account with the `moderator` or `admin`
role (`src/admin-status/admin-status-incidents.controller.ts:49-51`). The
controller's own comment explains the deliberately wide grant: "an incident is
often first noticed by whoever is working the moderation queue at 2am, and the
cost of a moderator publishing a status note is far lower than the cost of nobody
publishing one" (`admin-status-incidents.controller.ts:38-42`).

---

## 1. Severity

These map **exactly** onto the three values `status_incidents.severity` already
stores (`src/status/entities/status-incident.entity.ts:18-22`). There is no
parallel scale, no SEV-1 through SEV-4, and nothing to translate between. What
you pick in the admin form is what this table describes.

The public page folds severity into a component state:
`minor` and `major` both read as `degraded`, `critical` reads as `down`
(`src/status/status.service.ts:36-40`). The three-way split exists because "the
write-up itself wants the distinction ('slower than usual' is not 'half of it is
failing'), while a member scanning the page only ever needs to know whether a
thing works"
(`src/status/entities/status-incident.entity.ts:10-16`).

### `minor`

- **Qualifies:** a slow but working surface; a non-critical feature failing for
  some members; a cosmetic break that does not block a task; a planned
  maintenance window announced in advance.
- **Response expectation:** acknowledge within **one working day**. Fix on the
  normal work queue.
- **Who is woken:** nobody. Handle it in working hours.
- **Are members told:** **yes, if it is member-visible.** A minor incident that
  nobody outside the team can see does not need a post. One that members will hit
  does, because a member who hits it and finds an empty status page concludes the
  problem is their account.
- **Public effect:** the named components read `degraded`.

### `major`

- **Qualifies:** a core surface substantially broken for many members. Messaging
  not sending. Sign-in failing intermittently. Uploads rejected. A moderation
  action applied to the wrong member. Any suspected personal data exposure, until
  scoped (§8).
- **Response expectation:** **within one hour**, day or night. Status post
  published within **30 minutes** of declaring.
- **Who is woken:** the incident commander, and the deputy if the commander has
  not answered within 30 minutes.
- **Are members told:** **always.** Post at declaration, update at least every
  two hours while open, and post again at resolution.
- **Public effect:** the named components read `degraded`.

### `critical`

- **Qualifies:** the platform is down or unusable for most members. Sign-in fully
  broken. Database unreachable. Data loss suspected or confirmed. A confirmed
  personal data breach affecting many members. A compromised admin account.
- **Response expectation:** **immediately**, at any hour. Status post within
  **15 minutes** of declaring, even if the post says only that something is wrong
  and is being looked at.
- **Who is woken:** the incident commander, the deputy, and communications. On a
  suspected breach, also the breach lead
  (`docs/ops/breach-notification.md` §0).
- **Are members told:** **always, first.** Publishing precedes diagnosis. "We
  know, we are on it" published in five minutes beats a precise explanation in
  two hours.
- **Public effect:** the named components read `down`.

### Choosing between them

If a reasonable member would say "the platform is broken", it is at least
`major`. If they would say "QueerPulse is down", it is `critical`. When you are
between two levels, **pick the higher one and lower it later**; the admin form
supports editing an incident in place (`PATCH /admin/status/incidents/:id`,
`src/admin-status/admin-status-incidents.controller.ts:85-91`).

---

## 2. Lifecycle

### 2.1 Detect

Someone notices. See §4 on why that is currently a person rather than a monitor.

### 2.2 Declare

Say the word "incident" in whatever channel the team uses, name the severity, and
**publish the status post**. Publishing is what makes the declaration real: an
undeclared incident is a conversation, and a conversation does not reach a member
who cannot sign in.

- **Screen:** `/admin/status-incidents`
  (`queerpulse/src/app/routeMap.ts:117`,
  `queerpulse/src/features/admin/AdminStatusIncidentsPage.tsx`).
- **Endpoint:** `POST /admin/status/incidents`
  (`src/admin-status/admin-status-incidents.controller.ts:74-80`).
- **Fields:** `title` (3 to 160 characters), `body` (1 to 4000), optional
  `affectedComponents`, `severity`, `status`, `startedAt`
  (`src/admin-status/dto/create-status-incident.dto.ts:26-54`).
- **Set `startedAt` to when the trouble began rather than when you noticed.** The DTO
  says so: "Defaults to now, which is rarely right"
  (`create-status-incident.dto.ts:51`).
- **Components** are validated against the registry rather than accepted as free
  text, so a typo 400s at the desk instead of publishing an incident that appears
  to affect nothing (`create-status-incident.dto.ts:21-24`). The six valid ids
  are `accounts`, `messaging`, `communities`, `directory`, `magazine`, `media`
  (`src/status/status-components.ts:41-48`).
- **An empty component list is legitimate**, and means "worth announcing,
  degrades nothing", which is what a maintenance notice is
  (`src/status/entities/status-incident.entity.ts:77-83`).
- **Write plain prose.** `title` and `body` are sanitised to plain text at the
  write boundary because they render verbatim to unauthenticated visitors
  (`src/admin-status/admin-status.service.ts:47-51`). Markup will not survive.

### 2.3 Assign an incident commander

Name one person, out loud, in the channel. The commander owns the incident until
it is resolved or explicitly handed over, and their job is to coordinate rather
than to fix. On a `major` or `critical` incident the commander should not also be
the person with their hands in the code.

### 2.4 Communicate

Update the incident, do not open a new one. `PATCH /admin/status/incidents/:id`
is a partial update; omitted fields stay
(`src/admin-status/admin-status-incidents.controller.ts:82-91`).

Move it to `monitoring` when you believe it is fixed but are still watching. That
state still counts against the affected components, "because a fix that is not
yet trusted is not yet a fix"
(`src/status/entities/status-incident.entity.ts:24-29`).

Cadence: `critical` every 30 minutes even with nothing new to say, `major` every
two hours, `minor` at resolution.

### 2.5 Mitigate

Restore service before you understand the cause. Available levers:

- **Roll back the deploy.** `railway.json` runs
  `migration:preflight && migration:run:prod && storage:cors` as
  `preDeployCommand` (`railway.json:8-10`), so a rollback has to be checked
  against the migration state.
- **Platform lockdown.** `lockdownEnabled` with a `lockdownMessage`, optionally
  still letting moderators in via `lockdownAllowsModerators`
  (`src/platform-settings/platform-settings.service.ts:33-41`). The public status
  page and the health probes stay reachable throughout
  (`src/admin-status/admin-status-incidents.controller.ts:44-47`,
  `src/health/health.controller.ts:41`).
- **Sitewide announcement banner.** `announcementEnabled` plus
  `announcementMessage`, served by the **public** `GET /platform-status`
  (`src/platform-settings/platform-status.controller.ts:80-124`), so it reaches
  signed-out visitors too.
- **Close registration.** `registrationEnabled`, `joinRequestsEnabled`
  (`platform-settings.service.ts:33-41`).
- **Data loss:** stop and go to `docs/ops/backup-restore.md` §4 before touching
  the database further.
- **Suspected compromise:** rotate the credential first, investigate second
  (`docs/ops/breach-notification.md` §5 step 3).

### 2.6 Resolve

`POST /admin/status/incidents/:id/resolve`, which is idempotent and keeps the
first timestamp (`src/admin-status/admin-status-incidents.controller.ts:93-100`).
A resolved incident stops degrading its components
(`src/status/status.service.ts:162`) and stays visible on the public page for
**30 days** (`RESOLVED_WINDOW_DAYS`, `src/status/status.service.ts:31, 107-116`).

Before resolving, confirm the thing actually works from a member's side rather
than from a log line.

### 2.7 Review

Within **10 working days**. §7.

---

## 3. Who declares, and how, in one line each

| Situation | Action |
|---|---|
| A member reports something broken | Reproduce. If it is real and member-visible, declare at least `minor`. |
| An operator sees errors piling up in Sentry | Declare `major` and investigate. |
| Sign-in is failing | Declare `critical`. `accounts` is the component. |
| A deploy went wrong | Declare `major`, roll back, then diagnose. |
| Suspected data exposure | Declare `major` at minimum, and start the breach clock in parallel (§8). |
| Planned maintenance | Publish a `minor` incident **in advance**, with `startedAt` set to the window's start and an empty component list. |

---

## 4. Detection is weak today, and this process assumes it

**Say this plainly rather than designing around a monitor that does not exist.**

What exists:

- `GET /health/live`, public and unthrottled, touching nothing external. This is
  the one the orchestrator probes (`src/health/health.controller.ts:81-87`,
  `railway.json:12`).
- `GET /health` and `GET /health/ready`, which ping the database and sit behind
  `MetricsTokenGuard`, the same shared-secret gate as `/metrics`, scraped with
  `Authorization: Bearer $METRICS_TOKEN`
  (`src/health/health.controller.ts:24-34, 57-61, 93-97`).
- `GET /metrics`, public route, token-guarded
  (`src/metrics/metrics.controller.ts:27-31`).
- Sentry, when `SENTRY_DSN` is set (`src/instrument.ts:22-31`).

What does not exist:

- **Nothing scrapes any of them.** That is finding **LB-05**. There is no
  Prometheus, no uptime monitor, no alert rule, and no pager.
- **No alert on a failed backup.** `docs/ops/backup-restore.md` §7 names this as
  "the single highest-value alert here": a nightly job that pages if the newest
  off-provider dump is more than 26 hours old.
- **No alert on stuck deletion rows.** A failed erasure parks in `processing` for
  a human to look at (`src/account/account-deletion-processor.service.ts:171-190`),
  and no human is told.
- **No alert on a retention sweep failing.** Every retention cron swallows and
  logs its own errors so a rejection cannot crash the process, for example
  `src/notifications/notification-retention.service.ts:61-65`. Correct behaviour,
  and it means a sweep can fail silently every night.

**Consequence for this process:** the detection step in §2.1 is a **person**.
Usually a member. Design the rest of the process to work on that assumption:

- Watch the report and contact surfaces the way you would watch an alert channel.
- Take "is it just me?" from a member seriously the first time.
- Publish early, because the platform will often learn about an outage from the
  people it is failing.

**Dependency.** Everything below becomes possible once LB-05 lands and something
scrapes the endpoints:

1. An uptime check against `/health/live` from outside Railway, alerting on two
   consecutive failures.
2. An authenticated check against `/health/ready`, alerting on database
   unreachability.
3. A backup-freshness alert (`docs/ops/backup-restore.md` §7).
4. A Sentry alert rule on error-rate spikes, routed somewhere a human sees at
   03:00.
5. An automatic `critical` status incident on a sustained `/health/ready`
   failure, which would make §2.2 self-executing for the worst case.

Until then, treat the response expectations in §1 as measured from **the moment a
person notices**, and accept that this can be hours.

---

## 5. Communication channels, in order

There is no email (`docs/ops/no-mailer-at-launch.md`,
`src/account/account.constants.ts:29-35`, `src/migrations/1795740000000-DropEmailPreference.ts`). The full analysis of what each channel
reaches and what it misses is in `docs/ops/breach-notification.md` §4. In short:

1. **The public status page** is primary. `GET /status`, rendered at
   `/system/status` (`queerpulse/src/app/routeMap.ts:307`,
   `queerpulse/src/features/system/StatusPage.tsx`). It reaches anyone who
   visits, signed in or not, including a member who cannot sign in. It is
   lockdown-exempt, so what is published stays readable through a lockdown. Its
   whole reason for existing is that "a member who cannot sign in has no channel
   that can reach them and no way to tell 'the platform is down' from 'I am
   banned' from 'my account is broken'"
   (`src/status/entities/status-incident.entity.ts:36-46`).
   Cache behaviour is tuned for exactly this moment: browsers always revalidate,
   and the CDN holds the last known payload for up to 60 seconds while it
   revalidates, "because an outage is exactly when the origin is least able to
   answer" (`src/status/status.cache.ts:9-19`).
2. **The sitewide announcement banner** is second, for anything a visitor should
   see without going to look
   (`src/platform-settings/platform-status.controller.ts:80-124`). Public, so it
   reaches signed-out visitors. Dismissible, so it is not a receipt.
3. **In-app notification** is third, and only where a specific set of members is
   affected (`src/notifications/notifications.service.ts:160-170`). Note the
   constraint: **no bulk-notification tool exists**, so this needs a code change
   today (`docs/ops/breach-notification.md` §4.3).
4. **Web Push** reaches only members who already hold a subscription, and
   previews are hidden by default, so a push says "open QueerPulse" rather than
   carrying the news (`src/push/push-preview-privacy.service.ts:42-45`).
5. **There is no email.** Never write copy that implies one is coming.

---

## 6. Status post templates

Plain text only (`src/admin-status/admin-status.service.ts:47-51`). Title at most
160 characters, body at most 4000
(`src/admin-status/dto/create-status-incident.dto.ts:27-35`). Write for a member
who is frustrated and possibly frightened that the problem is their account.

### 6.1 `minor`

```
Title:    Photo uploads are slower than usual
Severity: minor
Affected: media
Started:  <when it began, which is rarely when you noticed>

We are seeing slower than usual photo uploads. Uploads are going through,
they are just taking longer than they should. Nothing has been lost.

We are working on it and will update this page when it is back to normal.
```

### 6.2 `major`

```
Title:    Direct messages are not sending
Severity: major
Affected: messaging
Started:  <when it began>

Direct messages are failing to send for many members right now. Messages
already in your conversations are safe and are not affected.

If a message did not send, it was not delivered. You will need to send it
again once this is fixed.

We know what is happening and are working on it. Next update within two
hours.
```

Update while open:

```
Update <time>: we have identified the cause and are deploying a fix. We
expect messaging to be working again within the hour.
```

Move to `monitoring`:

```
Update <time>: the fix is out and messages are sending again. We are
watching it for the next hour before calling this resolved.
```

### 6.3 `critical`

Publish the first one within 15 minutes, even with nothing to say.

```
Title:    QueerPulse is unavailable
Severity: critical
Affected: accounts, messaging, communities, directory, magazine, media
Started:  <when it began>

QueerPulse is not loading right now. This is a problem on our side, not
with your account. You are not banned and you have not been logged out.

We are working on it. Next update within 30 minutes.
```

### 6.4 Planned maintenance

Publish in advance, with an empty component list.

```
Title:    Planned maintenance, <date> <start>-<end> <timezone>
Severity: minor
Affected: (none)
Started:  <the window's start>

We are making a database change on <date> between <start> and <end>.
QueerPulse may be briefly unavailable during that window. Nothing you have
posted or sent will be affected.
```

### 6.5 Resolution

Resolve through `POST /admin/status/incidents/:id/resolve`, and update the body
first so the resolved incident reads as a complete record. It stays on the public
page for 30 days (`src/status/status.service.ts:31`).

```
Resolved <time>: <what was wrong, in one sentence>. <What we did.> Everything
is working normally again. <If members need to do anything, say it here; if
not, say "There is nothing you need to do.">
```

**Never resolve an incident without a closing line.** A member returning to the
page a week later should be able to tell what happened.

---

## 7. Blameless post-incident review

Run it within **10 working days** of resolution, for every `major` and
`critical`, and for any `minor` that surprised someone.

**Blameless means blameless.** The question is never who typed the command, it is
what made it possible to type it and land in production without anything catching
it. A review that produces a name has failed. A review that produces a guard has
worked.

`[OWNER: decide and record where post-incident reviews are kept]`

```
POST-INCIDENT REVIEW
Incident:        <status incident title>
Severity:        minor / major / critical
Incident id:     <uuid from the admin queue>
Commander:       <name>
Review author:   <name>
Review date:     <date>

TIMELINE (times, and how each was established)
  Began:            <startedAt>
  First noticed:    <when, and BY WHOM: a member, an operator, a monitor>
  Declared:         <when>
  Status published: <when>
  Mitigated:        <when>
  Resolved:         <when>
  Time to detect:   <began -> first noticed>
  Time to declare:  <first noticed -> declared>
  Time to mitigate: <declared -> mitigated>

IMPACT
  Members affected (estimate, and the basis for it):
  Surfaces affected:
  Data lost or altered:                      yes / no
  Personal data disclosed:                   yes / no  -> if yes, go to §8
  Anything a member has to do about it:

WHAT HAPPENED
  The narrative, in order, with no attribution of fault.

WHY IT HAPPENED
  Contributing factors, several. If there is only one, look harder.

WHAT WENT WELL
  Name it. A review that lists only failures teaches nobody what to repeat.

WHAT MADE IT WORSE
  Missing detection. A misleading log line. A runbook that was wrong. A person
  who could not be reached. The absence of a lever.

DETECTION
  How was this found? If the answer is "a member told us", that is a finding,
  and today it is the expected answer (§4).
  What would have caught it sooner, and is it worth building?

COMMUNICATION
  Was the status post published inside the §1 expectation?
  Was it understandable to someone who is not an engineer?
  Which channels were used, and who was not reachable at all?

ACTIONS
  | # | Action | Owner | Due | Guard or fix? |
  Every action gets a named owner and a date. An action with neither is a wish.
  Prefer actions that make the failure impossible over actions that ask people
  to be more careful.

WAS THIS ALSO A PERSONAL DATA BREACH?
  yes / no, with the reasoning.
  If yes: breach reference, awareness timestamp, and whether the Article 33
  and Article 34 decisions were made inside their deadlines. See
  docs/ops/breach-notification.md §8, which adds four further questions this
  template does not ask.

DOCUMENTS TO UPDATE
  [ ] docs/ops/incident-response.md
  [ ] docs/ops/backup-restore.md
  [ ] docs/ops/breach-notification.md
  [ ] docs/ops/retention-periods.md
  [ ] docs/ops/sub-processors-and-processing.md
  [ ] docs/ops/dpia-housing-verification-messaging.md
```

---

## 8. When an incident is also a personal data breach

The moment personal data may have been disclosed, altered without authority, or
irrecoverably lost, **a second clock starts** and it is not this one.

1. **Keep running the incident.** Restoring service and containing exposure are
   the same work.
2. **Start the breach procedure in parallel**, at
   `docs/ops/breach-notification.md` §2. Record the awareness timestamp
   immediately: it is the most consequential fact in that whole procedure, and it
   is the one nobody remembers afterwards.
3. **Tell the breach lead**, who is a distinct role from the incident commander
   (`docs/ops/breach-notification.md` §0).
4. **Severity is at least `major`**, and `critical` where many members are
   affected or Article 9 data is involved.
5. **The status post is not the breach notification.** It says the platform had a
   problem. A breach notification says what data was involved and what it means
   for the member, and it follows the template at
   `docs/ops/breach-notification.md` §6.2.
6. **Do not speculate publicly about scope.** "We are investigating whether any
   member data was affected and will update this page" is honest. Naming a number
   you later have to correct is not.
7. **Irrecoverable data loss is a notifiable breach in its own right**, on top of
   being an availability problem. Go to `docs/ops/backup-restore.md` §4 for the restore
   and to `docs/ops/breach-notification.md` §1 for the classification.

---

## 9. Quick reference

| Need | Where |
|---|---|
| Publish or edit a status incident | `/admin/status-incidents` (`queerpulse/src/app/routeMap.ts:117`) |
| Create | `POST /admin/status/incidents` (`src/admin-status/admin-status-incidents.controller.ts:74-80`) |
| Update | `PATCH /admin/status/incidents/:id` (`admin-status-incidents.controller.ts:85-91`) |
| Resolve | `POST /admin/status/incidents/:id/resolve` (`admin-status-incidents.controller.ts:93-100`) |
| Public status page | `/system/status` (`queerpulse/src/app/routeMap.ts:307`), `GET /status` |
| Valid component ids | `accounts`, `messaging`, `communities`, `directory`, `magazine`, `media` (`src/status/status-components.ts:41-48`) |
| Severity values | `minor`, `major`, `critical` (`src/status/entities/status-incident.entity.ts:18-22`) |
| Incident statuses | `open`, `monitoring`, `resolved` (`src/status/entities/status-incident.entity.ts:30-34`) |
| Lockdown and announcement switches | `src/platform-settings/platform-settings.service.ts:33-41` |
| Liveness probe | `GET /health/live`, public (`src/health/health.controller.ts:81-87`) |
| Readiness probe | `GET /health/ready`, bearer token (`src/health/health.controller.ts:93-97`) |
| Metrics | `GET /metrics`, bearer token (`src/metrics/metrics.controller.ts:27-31`) |
| Data-loss playbook | `docs/ops/backup-restore.md` |
| Breach procedure | `docs/ops/breach-notification.md` |
