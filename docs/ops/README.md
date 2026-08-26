# Operations documentation

Runbooks, decision records and compliance documents for running QueerPulse in
production. Everything here is grounded in code that exists: a factual claim in
any of these documents carries the `path/to/file.ts:line` that proves it, and
anything unproven is marked **UNVERIFIED, needs a human answer** rather than
guessed at.

## Legal and compliance

| Document | What it is |
|---|---|
| [`sub-processors-and-processing.md`](sub-processors-and-processing.md) | Every third party that processes QueerPulse personal data, derived from the code, plus the GDPR Article 30 record of processing activities. |
| [`retention-periods.md`](retention-periods.md) | Every retention period the code actually enforces, with the sweeper and its cron, plus the list of places the published privacy policy disagrees with it. |
| [`dpia-housing-verification-messaging.md`](dpia-housing-verification-messaging.md) | The Article 35 data protection impact assessment for the three highest-risk surfaces: home addresses, identity verification, and private messaging. |
| [`dsar-runbook.md`](dsar-runbook.md) | How a data-subject request is received, verified, worked and closed, with the service level and the owner. |
| [`breach-notification.md`](breach-notification.md) | The procedure for the 72 hours after becoming aware of a personal data breach, including how members are told without any email channel. |
| [`accessibility-legal-basis.md`](accessibility-legal-basis.md) | Why the published accessibility statement is voluntary: how Decreto-Lei n.º 82/2022 reads against this platform, which regulator would apply if paid ticketing ever shipped, and the questions still open for a lawyer. Internal. |

## Running the platform

| Document | What it is |
|---|---|
| [`incident-response.md`](incident-response.md) | How an incident is declared, run, communicated and reviewed. Severity levels map exactly onto what `status_incidents` already stores. |
| [`backup-restore.md`](backup-restore.md) | The backup layers, the restore procedure, the rehearsal, and the object-storage posture. The data-loss playbook. |

## Decisions

| Document | What it is |
|---|---|
| [`no-mailer-at-launch.md`](no-mailer-at-launch.md) | The decision record: QueerPulse ships with no transactional mailer, which flows are affected, and how each behaves without one. |
| [`no-email-at-launch.md`](no-email-at-launch.md) | The companion note on the same decision, with the copy audit and the wire order for when a mailer lands. |

## One standing fact

**QueerPulse delivers no email and never will.** There is no mail transport, no
provider, and no sender (`src/account/account.constants.ts:29-35`, `src/migrations/1795740000000-DropEmailPreference.ts`). Any procedure
in this directory that would ordinarily say "email the affected people" instead
uses the channels that exist: the public status page, the sitewide announcement
banner, in-app notifications, and Web Push to members who already hold a
subscription. The reach and the limits of each are set out in
[`breach-notification.md`](breach-notification.md) §4.

**One stale comment to ignore, recorded so it does not mislead the next reader.**
`src/migrations/1793610000000-AddNewsletterDigestLedger.ts:9` explains its batch
sizing in terms of "subscribers x SMTP round trip (the mailer allows 8s to
connect and 8s per...)". There is no mailer and no SMTP connection anywhere in
this repository, and nothing reads the newsletter ledger to send anything. The
comment is applied migration history, which is frozen by the rule in the root
`CLAUDE.md`, so it stays exactly as written. Read it as an artefact of a plan
that was dropped, never as a description of a system that runs.
