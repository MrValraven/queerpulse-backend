# Join-request review rubric

**Version 1.0 — 2026-08-18**

This is the rubric admins and moderators use when reviewing a "request an invite" submission. It is versioned the same way the Terms and the community guidelines are (see `join_requests.terms_version`): when this document changes in a way that affects how a decision should be made, bump the version and note what changed below. A decision made under an old version stays valid; it isn't retroactively wrong because the rubric moved.

Companion engineering/design work: `docs/superpowers/plans/2026-08-18-invite-review-guidelines-backend.md` and the sibling plan in `queerpulse/docs/superpowers/plans/`. Full research behind this rubric: https://claude.ai/code/artifact/5025a257-4900-44ec-b792-b57c9ad533a1

## The core call

Approving someone who shouldn't be here puts existing members at risk. Declining someone who genuinely belongs here shuts a door that mattered to open — for a closeted person, an ally, or anyone who found QueerPulse through an unfamiliar path, that door may not reopen. Both costs are real. This rubric doesn't pretend the tension goes away; it says which way to lean when a case is genuinely ambiguous.

**In the ambiguous middle, lean toward approving.** Not because every request deserves the benefit of the doubt regardless of what it contains, but because the front gate is not the only safety layer. A member's history is visible after approval. The vouch network and community moderation are a second line of defense behind this one, not a replacement for it, but they exist precisely so this gate doesn't have to be airtight on its own. A borderline-but-plausible applicant admitted in error costs less than a genuine applicant turned away.

This does not apply to a request with a real safety signal (see "Red flags" below) — lean toward approving *ambiguity*, not risk.

## What is never a valid reason to decline

**A name, photo, or pronouns that don't "read" as queer enough.** Identity can't be inferred from any of these. Some applicants are closeted, some are still figuring themselves out, some are allies who will never present as queer at all, and none of that is a reason to say no. This mirrors a real, working precedent: Lex's own moderation policy explicitly rules out "you don't think someone belongs because of their gender" as valid grounds for action, for exactly this reason.

If a decline reason boils down to a gut feeling about who someone is rather than something in the request itself (a red flag below, or a plain policy violation like being under 18), it is not a valid reason. Pick "Details don't add up" only when something concrete doesn't add up, not as a stand-in for "something about this feels off in a way I can't name."

## Red flags — worth a closer look, never an automatic decline

The queue surfaces a few signals automatically. None of these should be acted on by themselves — they exist to tell a reviewer where to look more carefully, not to make the decision.

- **Disposable email address.** A known throwaway-email domain. Common for spam, but also how a genuinely cautious person might first test the waters. Look at the rest of the request before deciding this means anything.
- **Duplicate message.** The same wording as another currently pending request — likely a copy-paste spam pattern, occasionally a coincidence.
- **Source burst.** An unusual volume of requests through the same entry point in a short window — could be a coordinated flood, could be a single CTA getting real, organic traffic that day.
- **Prior decline.** The email was declined before. Read why it was declined last time (the reviewer's recorded reason) before deciding whether this attempt is different.

## Reapplication policy

**30 days.** Someone declined has to wait 30 days before submitting again. This is enforced technically (the backend rejects an earlier resubmission), not just a norm — see the engineering plan's Task 1. It exists so a decline isn't trivially bypassed by hitting submit again, while staying short enough that someone whose circumstances genuinely changed isn't locked out for a season.

## Escalation

**Keep it formal.** If a case is genuinely hard, route it to another moderator or admin through the normal review queue, not through a personal message to whoever you happen to know on the team. Most people outside the review role don't have the context to help, and deciding based on a personal relationship with either the applicant or the person you're asking is exactly the failure mode this rule exists to prevent.

**If you personally know the applicant, hand the decision to someone who doesn't.** Don't self-approve or self-decline someone you have an outside relationship with, even a good one.

## Identity verification — what we do and don't do

We check: an email that resolves to a real, active member when a mutual reference is given (queue shows this as "Corroborated by [name]"), the applicant's own stated reason, and the confidence signals above.

We deliberately don't require: government ID, a selfie, a phone number, or any other heavyweight verification. Two real platforms in this space make the same call for the same reason — Slack's own verified-organization badge is criteria-based and Slack says outright it can't guarantee legitimacy; Lex uses report-volume thresholds, not documents. Heavyweight verification is disproportionate here, and a real barrier for someone who isn't safely out. Don't build toward it without revisiting this rubric first.

## Decline communication

**Every decline sends an automatic, generic email**: "We're not able to extend an invite right now." No specific reason is included in that email, even when the reviewer's internal record is specific. Two reasons: consistency (nobody is left wondering whether their request even arrived), and safety (nothing in the email itself could be a risk if it's ever seen by someone else). The applicant can submit again after the 30-day cooldown.

The decline reason picked in the review UI is internal-only — it's for the audit trail and the sampling pass below, never surfaced to the applicant.

## Source attribution — context only, never a penalty

The "came from" line on a request tells a reviewer which page or CTA sent the applicant here. Use it as context. **Never let it count against a request** — someone arriving through a less common entry point is not more suspicious by default, and treating it that way would quietly penalize exactly the applicants most likely to arrive somewhere unusual: a first-timer, or someone closeted who found QueerPulse indirectly rather than through a typical marketing surface.

## Review target

**Three business days.** Not a hard deadline, a target the waiting-time badge on each card is calibrated against — a request under 2 days reads as normal, 2–3 as approaching, past 3 as worth prioritizing. If the queue is consistently running past this, that's a staffing signal, not a reason to lower the bar on individual decisions.

## Quality sampling

Periodically — monthly is a reasonable cadence for a small team — pull a handful of last month's decisions on `/join-requests/sample` and have a *different* admin from the one who made the original call look at them. Compare notes on anything that reads differently in hindsight. This isn't a formal audit with a recorded second signoff (the tooling deliberately doesn't build that — see the frontend plan's Task 7); it's a standing habit that keeps two reviewers' bars from quietly drifting apart from each other.

## Vouch network — a signal, not a screen

A resolved mutual reference, or an applicant's connection to the broader vouch network, is real corroborating context. It is not proof of trustworthiness on its own, and it should not be treated as if it screens out bad actors the way a background check would — there's no evidence that peer/community networks reliably do that job by themselves. Weigh it as one input among several, not a shortcut past the rest of the rubric.

---

## Changelog

- **1.0 (2026-08-18):** Initial version, written alongside the invite-review guideline audit and its companion engineering/design plans.
