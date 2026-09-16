/**
 * PRD-366: the closed set of "who can message me" choices, stored on
 * `member_preferences.who_can_message` (see
 * `AddMessagingPrivacyPreferences1820500000000`, whose CHECK constraint
 * mirrors this exact set).
 *
 * A plain string union rather than a Postgres enum — see the migration's own
 * doc for why. This module owns the closed set so the DTO validator
 * (`update-messaging-privacy.dto.ts`) and the entity/response mapping can
 * never drift apart on what's a valid value.
 *
 * ENFORCED at send/request time by `ConnectionsService.resolveRequestGate`
 * (§8 request gate), layered ON TOP of `profiles.visibility` — the STRICTER
 * of the two always wins:
 *  - `'everyone'`: today's profile-visibility rules, unchanged — `open`
 *    connects freely, `network` requires a mutual-connection introducer,
 *    `private` is allowed but flagged for moderation.
 *  - `'introduced'`: a NEW request needs a mutual-connection introducer
 *    regardless of visibility — the same rule `network` visibility already
 *    applies, so this can only ever narrow an `open` profile, never loosen a
 *    `network`/`private` one.
 *  - `'connections'`: every new message or connection request is refused
 *    outright (403 `RECIPIENT_NOT_ACCEPTING_REQUESTS`, see
 *    `request-limits.ts`). An EXEMPTION: an enquiry about the member's own
 *    published listing (`MessageRequestsService.deliverEnquiry`) never
 *    passes through this gate — the member published that listing to be
 *    contacted, so `'connections'` narrows who may message them generally
 *    without also cutting off housing/listing enquiries.
 */
export const WHO_CAN_MESSAGE_VALUES = [
  'everyone',
  'introduced',
  'connections',
] as const;

export type WhoCanMessage = (typeof WHO_CAN_MESSAGE_VALUES)[number];

export const DEFAULT_WHO_CAN_MESSAGE: WhoCanMessage = 'everyone';
