# Join-request review rubric

**Version 1.1, 2026-10-08**

This is the rubric admins and moderators use when reviewing a "request an invite" submission. It is versioned the same way the Terms and the community guidelines are (see `join_requests.terms_version`): when this document changes in a way that affects how a decision should be made, bump the version and note what changed below. A decision made under an old version stays valid; it isn't retroactively wrong because the rubric moved.

Companion engineering/design work: `docs/superpowers/plans/2026-08-18-invite-review-guidelines-backend.md` and the sibling plan in `queerpulse/docs/superpowers/plans/`. Full research behind this rubric: https://claude.ai/code/artifact/5025a257-4900-44ec-b792-b57c9ad533a1

## The core call

Approving someone who shouldn't be here puts existing members at risk. Declining someone who genuinely belongs here shuts a door that mattered to open. For a closeted person, an ally, or anyone who found QueerPulse through an unfamiliar path, that door may not reopen. Both costs are real. This rubric doesn't pretend the tension goes away; it says which way to lean when a case is genuinely ambiguous.

**In the ambiguous middle, lean toward approving.** Lean this way because the front gate is not the only safety layer. A member's history is visible after approval. The vouch network and community moderation are a second line of defense behind this one, and this gate still does its own job. They exist precisely so the gate doesn't have to be airtight on its own. A borderline-but-plausible applicant admitted in error costs less than a genuine applicant turned away.

This does not apply to a request with a real safety signal (see "Red flags" below). The lean toward approving applies to *ambiguity* only.

## What is never a valid reason to decline

**A name, photo, or pronouns that don't "read" as queer enough.** Identity can't be inferred from any of these. Some applicants are closeted, some are still figuring themselves out, some are allies who will never present as queer at all, and none of that is a reason to say no. This mirrors a real, working precedent: Lex's own moderation policy explicitly rules out "you don't think someone belongs because of their gender" as valid grounds for action, for exactly this reason.

If a decline reason boils down to a gut feeling about who someone is, with nothing in the request itself behind it (a red flag below, or a plain policy violation like being under 18), it is not a valid reason. Pick "Details don't add up" only when something concrete doesn't add up, and name that concrete thing.

## Reviewing someone nobody here knows

More applicants now arrive with nobody on the platform to vouch for them. The queue shows a short version of this checklist above the cards, and a prompt on each card where nobody vouches.

1. **Look at their social profile, if they shared one.** Check that a real person is behind it and that it shows no hostility toward queer or trans people. A private account is fine.
2. **Read their message and how they heard about us.** Specific, personal answers are a good sign. Generic wording, copy-pasted text or a story that doesn't hold together deserves a closer look.
3. **Check the flags on the card.** Disposable email, duplicate message, burst, prior decline and ban evasion each tell you where to look, and none of them is a verdict.
4. **Still unsure? Ask them.** Use "Email {name} for more details" on the card to send a friendly note asking for a profile or a few lines about themselves, and waitlist them while you wait.
5. **Decline for a concrete reason:** hostile or hateful content, a fake or impersonated profile, a spam or commercial account, being under 18, or a ban-evasion match.

**Never a reason to decline:** no social link, a private account, or not "looking" or "posting" queer enough. Many people here aren't out, and a quiet profile can be how they stay safe.

When a social profile was what settled it, pick "Checked their social profile" as the approval reason, so the monthly sample shows how often it decides a case.

## Asking for more

The card's email button opens this note in English or Portuguese, ready to send from your own mail app. QueerPulse sends no email itself, so the reply comes to you.

> **Subject:** Your QueerPulse invite request
>
> Hi {name},
>
> Thanks for asking to join QueerPulse. Our team reads every request, and we'd like to get to know you a little before we send an invite.
>
> QueerPulse is a space for LGBTQIA+ people and allies, and keeping it safe matters a lot to everyone here. Since you're new to our community, we'd love to hear a little more about you. It helps us make sure everyone who joins is who they say they are and is here in good faith. We ask this of everyone who doesn't have a friend here yet.
>
> Could you reply with any one of these?
>
> - A link to a social profile (Instagram, TikTok, Bluesky or similar). If it's private, a screenshot of your profile page works too.
> - The name or email of someone already on QueerPulse who knows you.
> - A few lines about yourself and how you'd like to use QueerPulse.
>
> Only the review team sees what you send, and we use it for this request alone. If you're not out, or you'd rather keep your socials to yourself, that's completely fine. Tell us a bit more in your own words and we'll take it from there.
>
> Your request stays open while we wait to hear from you.
>
> Warmly,
> The QueerPulse team

Keep what they send in your inbox only for as long as the decision needs it.

## Red flags: worth a closer look and a human call

The queue surfaces a few signals automatically. None of these should be acted on by themselves. They exist to tell a reviewer where to look more carefully, and the decision stays with the reviewer.

- **Disposable email address.** A known throwaway-email domain. Common for spam, but also how a genuinely cautious person might first test the waters. Look at the rest of the request before deciding this means anything.
- **Duplicate message.** The same wording as another currently pending request. Likely a copy-paste spam pattern, occasionally a coincidence.
- **Source burst.** An unusual volume of requests through the same entry point in a short window. It could be a coordinated flood or it could be a single CTA getting real, organic traffic that day.
- **Prior decline.** The email was declined before. Read why it was declined last time (the reviewer's recorded reason) before deciding whether this attempt is different.
- **Ban evasion match.** The applicant's details match a removed account. Read the removed account's history in the panel before deciding. A match is a strong reason to look closely, and it still needs a human call.

## Reapplication policy

**30 days.** Someone declined has to wait 30 days before submitting again. This is enforced technically (the backend rejects an earlier resubmission). See the engineering plan's Task 1. It exists so a decline isn't trivially bypassed by hitting submit again, while staying short enough that someone whose circumstances genuinely changed isn't locked out for a season.

## Escalation

**Keep it formal.** If a case is genuinely hard, route it to another moderator or admin through the normal review queue and keep personal messages to whoever you happen to know on the team out of it. Most people outside the review role don't have the context to help, and deciding based on a personal relationship with either the applicant or the person you're asking is exactly the failure mode this rule exists to prevent.

**If you personally know the applicant, hand the decision to someone who doesn't.** Don't self-approve or self-decline someone you have an outside relationship with, even a good one.

## Identity verification: what we do and don't do

We check: an email that resolves to a real, active member when a mutual reference is given (queue shows this as "Corroborated by [name]"), the applicant's own stated reason, the confidence signals above, and the social profile they chose to share, if any.

We deliberately don't require: government ID, a selfie, a phone number, or any other heavyweight verification. Two real platforms in this space make the same call for the same reason: Slack's own verified-organization badge is criteria-based and Slack says outright it can't guarantee legitimacy; Lex uses report-volume thresholds alone. Heavyweight verification is disproportionate here, and a real barrier for someone who isn't safely out. Don't build toward it without revisiting this rubric first.

The social profile is optional. A missing or private profile is never a decline reason, and asking for one by email is a question the applicant is free to answer in their own words instead.

## Decline communication

QueerPulse sends no email. An applicant learns the outcome from their own status page, reached with the reference code they got when they submitted. The page opens with "Our team read your request, and we couldn't bring you in this time." and offers a "Get in touch" button to write to the team. Under "What we can tell you" it shows a short, kindly worded note matched to the decline reason you picked (an unspecified reason shows "The reviewer didn't leave a reason we can show you here. If you'd like to understand it, write to us and someone from our team will reply."), and an under-18 decline shows the supportive 18+ notice. The decline reason picked in the review UI feeds the audit trail and the sampling pass below, and the applicant sees only the softened wording above, which replaces the reviewer's own label. The applicant can submit again after the 30-day cooldown.

## Source attribution: context for the reviewer

The "came from" line on a request tells a reviewer which page or CTA sent the applicant here. Use it as context. **Let it carry no weight against a request.** Someone arriving through a less common entry point is not more suspicious by default, and treating it that way would quietly penalize exactly the applicants most likely to arrive somewhere unusual: a first-timer, or someone closeted who found QueerPulse indirectly.

## Review target

**Three business days is a target, with room for judgement: the waiting-time badge on each card is calibrated against it.** A request under 2 days reads as normal, 2-3 as approaching, past 3 as worth prioritizing. If the queue is consistently running past this, that's a staffing signal, and the bar for individual decisions stays where it is.

## Quality sampling

Periodically (monthly is a reasonable cadence for a small team) pull a handful of last month's decisions on `/join-requests/sample` and have a *different* admin from the one who made the original call look at them. Compare notes on anything that reads differently in hindsight. This is a standing habit (the tooling deliberately builds no recorded second signoff, see the frontend plan's Task 7) that keeps two reviewers' bars from quietly drifting apart from each other.

## Vouch network: one signal among several

A resolved mutual reference, or an applicant's connection to the broader vouch network, is real corroborating context. It is partial evidence of trustworthiness, and it screens out bad actors less reliably than a background check does. There's no evidence that peer/community networks reliably do that job by themselves. Weigh it as one input among several, with the rest of the rubric still applying.

---

## Changelog

- **1.0 (2026-08-18):** Initial version, written alongside the invite-review guideline audit and its companion engineering/design plans.
- **1.1 (2026-10-08):** Added "Reviewing someone nobody here knows" (optional social profile, five-step checklist, never-a-reason list) and "Asking for more" (the follow-up email). Corrected "Decline communication": the platform sends no email. Punctuation and wording cleanup throughout, plus a ban-evasion red flag.
