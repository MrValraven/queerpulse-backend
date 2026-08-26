# Personal Data Breach Notification Procedure

**Status:** LG-04. The procedure for the 72 hours after QueerPulse becomes aware
of a personal data breach.

**Read this first if a breach is suspected right now:** go to §2, start the
clock, and do not wait for certainty. GDPR Article 33 gives 72 hours from
**awareness**, which starts well before full understanding. §5 explains what to file when the
facts are still incomplete.

**Related:** `docs/ops/incident-response.md` (every breach is also an incident,
but not every incident is a breach), `docs/ops/backup-restore.md` (the data-loss
playbook), `docs/ops/dpia-housing-verification-messaging.md` (which surfaces
carry the highest harm).

---

## 0. Roles

Fill these in before an incident. Doing it during one is too late.

| Role | Who | What they own |
|---|---|---|
| **Breach lead** | `[OWNER: name and contact to be filled in]` | Declares a breach, owns the clock, makes the notify or do-not-notify call, signs the filing. |
| **Deputy breach lead** | `[OWNER: name and contact to be filled in]` | Everything above, when the lead is unreachable inside one hour. |
| **Technical investigator** | `[OWNER: name and contact to be filled in]` | Establishes scope: what data, whose, how many, for how long, and whether it is still happening. |
| **Member communications** | `[OWNER: name and contact to be filled in]` | Drafts and publishes the status post and the in-app notice. |
| **Data protection contact** | `[OWNER: name and contact to be filled in]` | Prepares the supervisory-authority filing and is the named contact on it. |

One person may hold several of these. What must never happen is that none of them
is named when something happens at 02:00.

**Supervisory authority.** The controller is established in Portugal, so the lead
supervisory authority is the **Comissão Nacional de Proteção de Dados (CNPD)**.
The published privacy policy already tells members they may complain to the CNPD
(`queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1141-1142`).

- **UNVERIFIED, needs a human answer:** the CNPD breach-notification filing URL,
  the form or portal it uses, and any account or reference the controller needs
  in advance. Confirm this **before** an incident, because 72 hours is not enough
  time to also work out where to file.
- **UNVERIFIED, needs a human answer:** whether the controller, having no legal
  entity (`queerpulse/src/shared/i18n/catalogs/en/marketing.ts:1050-1051`), can
  file in the name of the named natural persons acting as controllers, and who
  those are.

---

## 1. What counts as a personal data breach here

A personal data breach is a breach of security leading to the accidental or
unlawful destruction, loss, alteration, unauthorised disclosure of, or access to,
personal data. All three limbs count: **confidentiality**, **integrity**,
**availability**.

Concrete examples from this platform. These are the ones to recognise.

### Confidentiality breaches

- **A leaked database backup.** The `pg_dump` archives contain direct messages,
  email addresses and consent logs (`docs/ops/backup-restore.md` §2 says so in
  as many words). A dump landing in a public bucket, an unencrypted laptop, or a
  chat message is a breach affecting the entire membership.
- **A moderator or admin account takeover.** A moderator can read report evidence
  including verbatim message snapshots
  (`src/reports/reports.service.ts:413-422`), the DSAR queue
  (`src/admin-dsar/admin-dsar.controller.ts:46-52`), and the member directory.
  An admin can change roles and platform settings. Treat a confirmed takeover as
  a breach even with no evidence of what was read, because the audit trail
  records actions and never reads.
- **An object-storage key or credential exposure.** `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` give full read of the bucket
  (`src/config/env.validation.ts:134-138`). Every avatar, listing photo and
  direct-message image attachment is in there, keyed `<kind>/<userId>/…`, so the
  keys themselves link files to members
  (`src/account/account-deletion-processor.service.ts:353-354`).
- **A bug that showed one member another member's DMs.** Whether it lasted one
  request or one deploy, this is a confidentiality breach. Note the aggravating
  factor: message content on this platform routinely reveals sexual orientation,
  gender identity and health information, so it is Article 9 data
  (`docs/ops/dpia-housing-verification-messaging.md` §2.2).
- **A housing address disclosed to the wrong person.** The address gate is a
  single boolean (`src/housing-listings/housing-directory.service.ts:260-265`).
  A regression that inverted or bypassed it discloses `address_line` and precise
  coordinates (`src/housing-listings/entities/housing-listing.entity.ts:144-165`)
  to people the lister never let in. Small record count, very high severity.
- **A flatmate profile's special-category block served outside its consented
  audience** (out-at-home status, medication discretion, chosen-name post,
  `src/flatmate-profiles/entities/flatmate-profile.entity.ts:52-68`).
- **A JWT signing secret leak.** `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET`
  escaping lets anyone mint a session for any member. Treat as a breach affecting
  everyone.
- **A photo uploaded with EXIF intact** because the client-side strip failed
  silently, revealing where a member was
  (`queerpulse/src/features/members/api/uploads.api.ts:54-60`).

### Integrity breaches

- Unauthorised alteration of moderation records, consent logs or policy
  acceptances. These are the evidence trails
  (`src/moderation/entities/mod-audit-log.entity.ts:9-14`,
  `src/consent/entities/consent-record.entity.ts:21-25`,
  `src/consent/entities/policy-acceptance.entity.ts:26-27`), and altering them is
  a breach even if nothing was disclosed.

### Availability breaches

- **Irrecoverable data loss.** A bad migration or an accidental `DROP` with no
  usable backup. `docs/ops/backup-restore.md` opens by stating that until its §0
  checklist is green, "a bad migration or an accidental `DROP`/`DELETE` is
  **unrecoverable**". Permanent loss of members' personal data is a notifiable
  breach in its own right.
- A ransomware or provider-side event that puts data out of reach for a
  significant period.

### What is not a breach

- A member sharing their own screenshot.
- A member seeing content another member deliberately made public.
- A service outage with no data loss, alteration or disclosure. That is an
  incident (`docs/ops/incident-response.md`), and it may still warrant a status
  post.

When it is genuinely unclear, **treat it as a breach and start the clock.** A
clock you stop later costs nothing. A clock you start late cannot be restarted.

---

## 2. The clock

### 2.1 When awareness starts

Awareness is the moment the controller has a **reasonable degree of certainty
that a security incident has occurred that led to personal data being
compromised**. It is not the moment the investigation finishes.

A short period of initial verification is allowed and expected. What is not
allowed is treating "we have not confirmed the scope yet" as "we are not yet
aware".

In practice, awareness starts at the earliest of:

- a member, a researcher or a third party reports something that looks like
  exposure and a first look does not rule it out;
- an operator sees evidence in logs, in Sentry, or in the database;
- a provider tells the controller of an incident on their side;
- anyone on the team says out loud that data may have been exposed.

**Record the timestamp immediately**, in writing, in the incident record. That
single timestamp is the most consequential fact in the whole procedure.

### 2.2 The deadlines

| Clock | Starts | Runs for | Obligation |
|---|---|---|---|
| **Supervisory authority** (Art. 33) | Awareness | **72 hours** | Notify the CNPD, unless the breach is unlikely to result in a risk to rights and freedoms. |
| **Data subjects** (Art. 34) | Awareness | **Without undue delay** | Notify affected members when the breach is likely to result in a **high** risk to their rights and freedoms. |
| **Internal record** (Art. 33(5)) | Awareness | Always | Document every breach, including ones not notified, and why. |

**72 hours means 72 hours, including nights and weekends.** If awareness starts
at 18:00 on a Friday, the deadline is 18:00 on Monday.

### 2.3 Internal targets, set so the legal deadline is never the first one hit

| Hour | Target |
|---|---|
| **H+0** | Awareness timestamp written down. Breach lead informed. |
| **H+1** | Breach lead has decided: this is a breach, this is not a breach, or this needs investigation with the clock running. Containment started. |
| **H+4** | First scope estimate: which surface, which data categories, roughly how many members, still ongoing or stopped. |
| **H+12** | High-risk call made. If yes, member notification drafting starts now rather than after the CNPD filing. |
| **H+24** | Draft CNPD notification complete, even with gaps. |
| **H+48** | Filing reviewed and ready. |
| **H+60** | **File.** Twelve hours of margin left for something to go wrong. |
| **H+72** | Legal deadline. Nothing should be happening here. |

### 2.4 What to do when the facts are incomplete at hour 71

**Notify anyway, in phases.** Article 33(4) explicitly allows information to be
provided in phases where it cannot be provided at the same time. A late complete
notification is a breach of Article 33. An on-time partial one is not.

At hour 71 with an unfinished investigation, file with:

- what is known, stated as known;
- what is not known, stated as not known, with the words "investigation
  ongoing";
- what is being done to find out, and by when;
- an explicit commitment to a follow-up filing, with a date.

Then send the follow-up on that date, whether or not the picture is complete.
Repeat until it is.

Do not delay a filing to make it tidier. Do not delay a filing because the person
who would sign it is asleep. That is what the deputy in §0 is for.

---

## 3. The decision to notify

### 3.1 Notify the supervisory authority?

**Default: yes.** The exemption is narrow: only where the breach is "unlikely to
result in a risk to the rights and freedoms of natural persons".

On this platform, one factor makes that exemption harder to reach than it would
be elsewhere: **the fact of holding a QueerPulse account is itself a signal about
a person's sexual orientation or gender identity.** A leak of nothing but a list
of member email addresses is therefore a disclosure of special-category data, not
a minor contact-detail leak. Reason from that baseline rather than from record
counts.

Genuine candidates for not notifying: a strongly encrypted export whose key was
never exposed; data that was already public; an internal alteration caught and
reverted with no access by anyone unauthorised. Each of these still has to be
written into the internal record with the reasoning (§7).

### 3.2 Notify the members?

The Article 34 test is **high** risk. Notify members when any of these is true:

- direct message content was or may have been exposed;
- a housing address or precise coordinates reached someone outside the unlock
  gate;
- special-category identity data was exposed: flatmate identity fields, profile
  `identities`, or anything from which orientation or gender identity can be
  read;
- credentials or session tokens were exposed, so accounts may be taken over;
- the exposed set links a real name or email to a QueerPulse account for people
  outside the platform;
- the breach affects a member who is at heightened personal risk and the
  controller knows it.

Article 34(3) exemptions to consider honestly, and to record either way:
appropriate technical measures rendering the data unintelligible (real
encryption with an unexposed key), measures taken since that remove the high
risk, or a disproportionate-effort case that is then replaced by a public
communication. **The third one is close to QueerPulse's normal state**, because
of §4. Do not reach for it as a convenience.

---

## 4. Notifying members without email

**This is the hard part of this procedure and it must not be glossed over.**

QueerPulse delivers no email and never will
(`src/account/account.constants.ts:29-35`, `src/migrations/1795740000000-DropEmailPreference.ts`,
`docs/ops/no-mailer-at-launch.md`). There is no mailer, no provider, and no
sender. Every channel below is one that genuinely exists in the code. Each is
listed with what it actually reaches and, more importantly, what it does not.

### 4.1 The status page: `GET /status`, rendered at `/system/status`

- **What it is.** Operator-authored incidents on a public page, plus a derived
  component state. `src/status/entities/status-incident.entity.ts:36-46` records
  exactly why the table exists: "QueerPulse sends no email, so a member who
  cannot sign in has no channel that can reach them and no way to tell 'the
  platform is down' from 'I am banned' from 'my account is broken'."
- **Who writes it.** Moderators and admins, at
  `POST /admin/status/incidents`
  (`src/admin-status/admin-status-incidents.controller.ts:49-80`), through the
  admin screen at `/admin/status-incidents`
  (`queerpulse/src/app/routeMap.ts:117`,
  `queerpulse/src/features/admin/AdminStatusIncidentsPage.tsx`).
- **Reach.** Anyone who visits the URL, signed in or not, including a member
  locked out of the app. The public page is lockdown-exempt, so anything
  published stays readable through a lockdown
  (`src/admin-status/admin-status-incidents.controller.ts:44-47`).
- **Limit.** **It is a pull channel.** Nobody sees it unless they go and look. A member
  who does not open QueerPulse for a month sees nothing.
- **Note.** `title` and `body` are sanitised to plain text at the write boundary
  because they render verbatim to unauthenticated visitors
  (`src/admin-status/admin-status.service.ts:47-51`). Write in plain prose; no
  markup will survive.

### 4.2 The sitewide announcement banner

- **What it is.** `announcementEnabled` + `announcementMessage` +
  `announcementVersion` on the platform-settings row
  (`src/platform-settings/platform-settings.service.ts:33-41`), served by the
  **public** `GET /platform-status`
  (`src/platform-settings/platform-status.controller.ts:80-124`).
- **Reach.** Every visitor to the app, **signed in or not**, until they dismiss
  it. Signed-in members dismiss through `POST /announcement/:version/dismiss`
  (`src/platform-settings/announcement.controller.ts:46-57`); signed-out visitors
  dismiss locally in `localStorage`
  (`announcement.controller.ts:24-30`).
- **Limit.** It only appears to someone who opens the app. It is dismissible, so
  it is not a receipt. It supports no per-member targeting: everybody sees the
  same words.
- **This is the closest thing to a sign-in interstitial that exists.** There is
  no separate breach interstitial and no forced acknowledgement screen.

### 4.3 In-app notification

- **What it is.** A row in `notifications`, read at `GET /notifications`
  (`src/notifications/notifications.controller.ts:29-47`).
- **Reach.** Signed-in members. Notably, the controller deliberately omits
  `ActiveMemberGuard` so that a **pending** user can still read notifications
  (`src/notifications/notifications.controller.ts:25-26`).
- **Targeting.** `NotificationsService.createForRecipients` takes a list of user
  ids (`src/notifications/notifications.service.ts:160-170`), so a notification
  can be sent to exactly the affected set. This is the only channel with that
  property.
- **Preference filtering, and how to avoid it.** `createForRecipients` drops
  recipients who turned the notification's category off
  (`notifications.service.ts:170-175`). A breach notice must not be silenceable.
  Two facts make that achievable: a type listed in
  `ALWAYS_DELIVERED_NOTIFICATION_TYPES` bypasses the volume controls
  (`src/notifications/notification-preferences.ts:200-240`), and a type in
  neither map "is still always delivered", which is the documented safe default
  for a decision or outcome type
  (`src/notifications/notification-preferences.ts:180-185`).
- **Limit.** **There is no breach notification type today.** Sending one requires
  a code change: a new `NotificationType` and a way to fan it out to a list of
  members. Nothing in the admin console sends a bulk notification. See §8.
- **Limit.** A banned or suspended member is shut out of most in-app surfaces by
  `ActiveMemberGuard`, so a notification may be written and never read
  (`docs/ops/no-mailer-at-launch.md` §2c).

### 4.4 Web Push

- **What it is.** `src/push`, VAPID, delivered to a browser subscription.
- **Reach.** **Only members who already granted notification permission and hold
  a live subscription.** There is no way to create one for a member who never
  opted in.
- **Attrition.** Subscriptions with no successful delivery or re-subscribe in 90
  days are pruned (`src/push/push-subscription-retention.service.ts:53-71`), and
  the service's own docstring records a remaining gap where "a quiet, healthy,
  never-rotating device still ages out"
  (`push-subscription-retention.service.ts:30-35`). Treat push reach as a
  fraction of the membership, and an unknown fraction at that.
- **Content limit.** Previews are suppressed for members who asked for that, and
  hidden is the default when no preference row exists
  (`src/push/push-preview-privacy.service.ts:42-45`). A push must therefore say
  "open QueerPulse" rather than carrying the substance of the notice.
- **Limit.** VAPID is optional overall
  (`src/config/env.validation.ts:334-349`). If the keys are unset, push does not
  exist at all.

### 4.5 The honest statement of reach

Say this plainly in the internal record and, where relevant, to the CNPD:

> QueerPulse has no email channel. Members who have not granted push permission
> and who do not sign in are not reachable by any means the platform controls.
> Notification is therefore made by (a) a public status post, (b) a sitewide
> banner shown to every visitor including signed-out ones, and (c) a targeted
> in-app notification to the affected members, and is completed for each member
> at the moment they next open the platform.

That is a real Article 34(3)(c) situation: individual communication would involve
disproportionate effort because the means does not exist, so a public
communication is used instead. **State it as a limitation, never as a design
choice that makes it acceptable.**

### 4.6 Non-members

Invite applicants and newsletter subscribers have no account and therefore no
in-app channel at all (`docs/ops/no-mailer-at-launch.md` §2b). If a breach
touches `join_requests` or newsletter subscriber rows, the only available
communication is the public status page, and the internal record must say that
those data subjects could not be reached individually.

### 4.7 Recommended follow-ups (not capabilities that exist today)

Do not write any of these into a member-facing notice as though they work.

1. **A one-time acknowledged interstitial** on next sign-in, carrying a
   security-notice body and recording that the member saw it. The announcement
   banner is the nearest primitive and it is dismissible with no record for
   signed-out visitors.
2. **A bulk in-app notification tool** for moderators and admins, so a targeted
   notice does not need a deploy. Today it does.
3. **A breach `NotificationType`** added to
   `ALWAYS_DELIVERED_NOTIFICATION_TYPES` so it cannot be silenced.
4. **A minimal transactional mailer.** This is already the first post-launch
   infrastructure item in `docs/ops/no-mailer-at-launch.md` §3 for
   due-process reasons. Breach notification is another reason, and it is the only
   one of these four that reaches a member who never comes back.
5. **A push re-subscribe on boot** when the last successful sync is older than
   the retention window, closing the attrition gap the retention service
   documents (`push-subscription-retention.service.ts:30-35`).

---

## 5. Step by step

1. **Record the awareness timestamp.** In writing. Now.
2. **Tell the breach lead**, or the deputy if the lead is not reachable within
   one hour.
3. **Contain.** Rotate the exposed credential, revoke the sessions, ship the
   fix, take the surface down. Containment outranks investigation. Relevant
   levers: `POST /account/sessions` style revocation, the platform lockdown
   switch (`src/platform-settings/platform-settings.service.ts:33-41`), and
   rotating any of `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`,
   `AWS_SECRET_ACCESS_KEY`, `BAN_EVASION_PEPPER`. Note that rotating
   `BAN_EVASION_PEPPER` invalidates every stored hash and is documented as
   write-once (`src/config/env.validation.ts:156-161`).
4. **Preserve evidence.** Logs, Sentry events, database snapshots. Do not clean
   up before the investigator has looked. Take a snapshot per
   `docs/ops/backup-restore.md` §3 if the state matters.
5. **Scope it.** Which surface. Which data categories, using the entity names in
   `docs/ops/sub-processors-and-processing.md` §2. Approximately how many data
   subjects and how many records. Whether it is stopped.
6. **Declare a status incident** if members are affected or the platform is
   degraded (`docs/ops/incident-response.md` §3).
7. **Make the two calls** in §3, and write down the reasoning for each including
   a decision not to notify.
8. **File with the CNPD** by H+60 (§2.3), using §6.1.
9. **Notify members** through the channels in §4, using §6.2.
10. **Log it in the internal register** (§7).
11. **Run the post-incident review** (§8).

---

## 6. Templates

### 6.1 Supervisory authority notification skeleton

Article 33(3) requires the four numbered items. The rest is context that helps
the authority.

```
PERSONAL DATA BREACH NOTIFICATION
Controller: [OWNER: controller legal identity to be filled in]
Contact point: [OWNER: data protection contact, name, address, phone]
Our reference: QP-BREACH-YYYY-NN
Notification type: initial / follow-up (phase N of M)

1. NATURE OF THE BREACH
   What happened, in plain language.
   Breach type: confidentiality / integrity / availability (may be several).
   Categories of data subjects affected: [members / pending members / invite
     applicants / newsletter subscribers].
   Approximate number of data subjects: N   (estimate; basis for the estimate)
   Categories of personal data: [e.g. direct message content, home addresses,
     special-category identity data, authentication credentials].
   Approximate number of records: N
   Special-category data involved: yes / no. If yes, which and under which
     Article 9 condition it was held.

2. CONTACT POINT
   [OWNER: name, role, contact details]

3. LIKELY CONSEQUENCES
   Be specific about this community. Exposure of a QueerPulse account is, in
   itself, an indication of a person's sexual orientation or gender identity.
   Consequences to consider and state where applicable: involuntary outing at
   work, at home or to family; loss of housing; harassment or targeted violence;
   account takeover; loss of a communication channel a member depends on.

4. MEASURES TAKEN OR PROPOSED
   Containment already applied, with timestamps.
   Mitigation of adverse effects.
   Preventive measures, and by when.

TIMELINE
   Breach occurred (or earliest possible): ...
   Breach detected: ...
   Awareness established: ...            <- the Article 33 clock start
   Contained: ...
   This notification filed: ...

DATA SUBJECT NOTIFICATION
   High risk under Article 34: yes / no, with reasoning.
   Channels used: public status page, sitewide banner, in-app notification.
   Note for the authority: the controller operates no email channel. Members
   without an active push subscription who do not sign in cannot be reached
   individually. See "channels and their limits" attached.

PROCESSORS INVOLVED
   [from docs/ops/sub-processors-and-processing.md §1]

STILL UNKNOWN (initial notifications only)
   ...
   A follow-up notification will be filed by [date].
```

### 6.2 Member notification skeleton

Plain language. No hedging, no marketing voice, no apology that reads as
deflection. Under 250 words. Written so that the first sentence is enough on its
own, because that is all the banner will show.

```
TITLE
  A security incident affected your QueerPulse data

WHAT HAPPENED
  On [date], [what happened, in one or two sentences].
  We found out on [date] and [what we did, in one sentence].

WHAT DATA WAS INVOLVED
  [Name the categories exactly. "Your data" is not an answer. If direct
   messages, home addresses, or identity information were involved, say so in
   the first line of this section.]

WHAT WAS NOT INVOLVED
  [Say this only where it is certainly true. It is often the most useful
   sentence in the notice.]

WHAT THIS COULD MEAN FOR YOU
  [Concrete. Name outing risk directly where it applies. Do not minimise.]

WHAT WE HAVE DONE
  [Containment and fix, with dates.]

WHAT YOU CAN DO
  [Only actions that exist. For example: review your active sessions in
   Settings and sign out any you do not recognise; check your profile
   visibility settings. Do not invent a step.]

WHERE TO ASK
  [OWNER: contact to be filled in]
  You can also complain to the Comissão Nacional de Proteção de Dados (CNPD),
  Portugal's data protection authority.

  Note: QueerPulse does not send email. Any message claiming to be a QueerPulse
  security email is not from us.
```

That last line matters. A breach is exactly when phishing arrives, and "we never
email you" is a defence no platform with a mailer can offer.

### 6.3 Status post at each severity

See `docs/ops/incident-response.md` §6 for the severity-matched templates. A
breach that is also an outage uses those; a breach with no outage uses §6.2 and
is published as a `major` or `critical` status incident depending on the harm.

---

## 7. The internal breach register

Article 33(5) requires a record of **every** personal data breach, including the
ones not notified. Nothing in the codebase stores this. It is a document.

`[OWNER: location of the breach register to be decided and recorded here]`

One entry per breach, with: reference, awareness timestamp, description, data
categories, data subject categories, approximate numbers, the Article 33
decision with reasoning, the Article 34 decision with reasoning, channels used,
effects, remedial action, and a link to the post-incident review.

**A decision not to notify is itself an entry.** The reasoning is
the part an authority will ask for.

---

## 8. Post-incident review

Within **10 working days** of resolution, run the blameless review in
`docs/ops/incident-response.md` §7. A breach review adds four questions the
generic one does not ask:

1. **Time to awareness.** How long between the breach occurring and anyone
   knowing? What would have shortened it? If the honest answer is "a member told
   us", that is a detection finding, and it is currently the expected answer,
   because nothing scrapes `/health` or `/metrics` (finding LB-05,
   `docs/ops/incident-response.md` §4).
2. **Reach achieved.** How many affected members actually received the notice,
   through which channel, and how many were unreachable? Record the number. It is
   the evidence for or against building the follow-ups in §4.7.
3. **Whether the DPIA holds.** If the breach hit housing, verification or
   messaging, reopen `docs/ops/dpia-housing-verification-messaging.md`; §7 of that
   document lists a declared breach as a review trigger.
4. **Whether the sub-processor register was right.** If a processor was involved
   and was not in `docs/ops/sub-processors-and-processing.md` §1, that omission
   is its own finding.

Feed every action back into `docs/ops/incident-response.md` as a tracked item, so
the review produces changes rather than a document.
