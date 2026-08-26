import type { ReasonCode } from '../reports/reason-catalogue';
import type { ModActionCode } from '../moderation/dto/mod-action.dto';

export interface ModResponseTemplateSeed {
  label: string;
  body: string;
  reasonCode: ReasonCode | null;
  actionCode: ModActionCode | null;
}

/**
 * The starter response library, shipped so the picker is useful the first time
 * a moderator opens it rather than being an empty box asking them to invent
 * the platform's voice on the spot.
 *
 * SHIPPED AS A DATA MIGRATION, NOT THE DEV SEED. `src/database/seed.ts`
 * refuses to run when `NODE_ENV=production`, and an empty library in
 * production is precisely the situation this feature exists to fix, so
 * `SeedModResponseTemplates1794621000000` inserts these rows in every
 * environment. This file stays the single source of the copy, imported by
 * that migration (the pattern `SeedGovernanceContent` established).
 *
 * VOICE. Plain, specific, addressed to a person. Each one says what happened,
 * why it happened, what it means for the account, and what to do next. None of
 * them promise an email, because the platform sends none. All of them are a
 * starting point a moderator is expected to edit.
 *
 * PLACEHOLDERS. `{member}` and `{community}` only (see
 * `mod-response-template-placeholders.ts`). They are resolved in the frontend
 * at prefill time, so the moderator approves the finished words.
 */
export const modResponseTemplatesSeed: ReadonlyArray<ModResponseTemplateSeed> =
  [
    // ── Closing a report without enforcement ─────────────────────────────
    {
      label: 'Dismiss: nothing against the guidelines',
      reasonCode: null,
      actionCode: 'dismiss',
      body: 'Thank you for reporting this. We read it properly and looked at the full context, and we did not find anything that breaks the community guidelines, so we are closing the report without acting on it. That is not a judgement on how it felt to you. If this carries on or gets worse, report it again and say that you have reported it before, so we can look at the pattern rather than the single moment.',
    },
    {
      label: 'Dismiss: already handled',
      reasonCode: null,
      actionCode: 'dismiss',
      body: 'Thank you for reporting this. It had already been reviewed and dealt with before your report reached us, so we are closing this one rather than acting twice. Reporting it was the right thing to do.',
    },

    // ── Harassment ───────────────────────────────────────────────────────
    {
      label: 'Harassment: first warning',
      reasonCode: 'harassment',
      actionCode: 'warn',
      body: 'Hi {member}. We reviewed a report about how you have been treating another member in {community}. Repeatedly going after one person breaks our guidelines on harassment, whatever started it. Please treat this as a formal warning: stop contacting them, and stop referring to them in public posts. If it happens again we will restrict your account. You can appeal this decision from your account.',
    },
    {
      label: 'Harassment: content removed',
      reasonCode: 'harassment',
      actionCode: 'remove_content',
      body: 'Hi {member}. We removed something you posted in {community} because it targeted another member. Our guidelines do not allow that here. The rest of your account is unaffected. You can appeal this decision from your account.',
    },
    {
      label: 'Harassment: account restricted',
      reasonCode: 'harassment',
      actionCode: 'restrict',
      body: 'Hi {member}. After more than one report about targeted behaviour in {community}, we have restricted your account for the period shown on your account page. You can still read and browse. You cannot post, comment or send messages until the restriction lifts. You can appeal this decision from your account.',
    },

    // ── Hate speech ──────────────────────────────────────────────────────
    {
      label: 'Hate speech: content removed',
      reasonCode: 'hate_speech',
      actionCode: 'remove_content',
      body: 'Hi {member}. We removed your post in {community}. It used a slur or hateful language about a group of people, and our guidelines rule that out regardless of who says it or how it was meant. Please read the guidelines before you post again. You can appeal this decision from your account.',
    },
    {
      label: 'Hate speech: account closed',
      reasonCode: 'hate_speech',
      actionCode: 'ban',
      body: 'Hi {member}. Your account has been permanently closed for hate speech aimed at the people this platform exists to protect. This decision has no end date. You can appeal it once from your account, and a different moderator will review it.',
    },

    // ── Outing ───────────────────────────────────────────────────────────
    {
      label: 'Outing: content removed',
      reasonCode: 'outing',
      actionCode: 'remove_content',
      body: "Hi {member}. We removed your post in {community} because it revealed another member's identity without their consent. Outing someone can cost them their home, their job or their safety, so we treat it as one of the most serious things that can happen here. Do not repost it in any form, including a version with the name taken out. You can appeal this decision from your account.",
    },
    {
      label: 'Outing: account suspended',
      reasonCode: 'outing',
      actionCode: 'suspend',
      body: "Hi {member}. We have suspended your account because you shared another member's identity without their consent. This is the line we hold hardest, because the harm is not something anyone can undo afterwards. You can appeal this decision from your account.",
    },

    // ── Doxxing ──────────────────────────────────────────────────────────
    {
      label: 'Doxxing: content removed',
      reasonCode: 'doxxing',
      actionCode: 'remove_content',
      body: "Hi {member}. We removed your post because it contained another person's private information, such as their address, workplace, or phone number. That is never allowed here, even when the information can be found somewhere else. You can appeal this decision from your account.",
    },

    // ── Unwanted contact ─────────────────────────────────────────────────
    {
      label: 'Unwanted contact: stop-contact warning',
      reasonCode: 'unwanted_contact',
      actionCode: 'warn',
      body: 'Hi {member}. A member has told us they asked you to stop contacting them and that the messages kept coming. Please do not message them again, here or anywhere else on the platform, and do not ask someone else to pass anything on. If you contact them again we will restrict your account. You can appeal this decision from your account.',
    },

    // ── Impersonation ────────────────────────────────────────────────────
    {
      label: 'Impersonation: correct your profile',
      reasonCode: 'impersonation',
      actionCode: 'warn',
      body: 'Hi {member}. We reviewed a report that your profile presents you as a person or organisation you are not. Please correct the details that are inaccurate within seven days. Accounts that go on impersonating someone real are closed. You can appeal this decision from your account.',
    },

    // ── Discrimination ───────────────────────────────────────────────────
    {
      label: 'Discrimination: warning',
      reasonCode: 'discrimination',
      actionCode: 'warn',
      body: 'Hi {member}. We reviewed your post in {community} and found it discriminatory towards other members. Deliberate misgendering, deadnaming, and language that writes a group of people out of the room all break our guidelines. Please read them again before you post. You can appeal this decision from your account.',
    },

    // ── Spam and off-topic ───────────────────────────────────────────────
    {
      label: 'Spam: promotional post removed',
      reasonCode: 'spam',
      actionCode: 'remove_content',
      body: 'Hi {member}. We removed your post in {community} because it was promotion rather than a contribution to the conversation. If you run something you would like members to know about, the directory is the place for it, or ask a moderator first. Your account is unaffected.',
    },
    {
      label: 'Off topic: post removed',
      reasonCode: 'off_topic',
      actionCode: 'remove_content',
      body: 'Hi {member}. We removed your post from {community} because it was off topic for that space. There was nothing wrong with the post itself, and you are welcome to put it somewhere it fits better.',
    },
  ];
