/**
 * PRD-364: fired by `PreferencesService.updateMessagingPrivacy` only when the
 * PUT actually flips `sharePresence` (an unrelated field changing, or a PUT
 * that resends the same value, emits nothing). `typing`/read-receipt shares
 * need no equivalent event — both take effect on the next frame/`markRead`
 * call the gateway/`ConversationsService` handles, since neither one is a
 * standing broadcast state the way presence is.
 *
 * Presence, by contrast, is a state other clients are ALREADY holding (an
 * "online" they were told and are still displaying), so turning sharing off
 * must actively retract it rather than merely stop repeating it, and turning
 * it back on must actively resume it — see `ChatGateway`'s listener.
 */
export const MESSAGING_PRIVACY_SHARE_PRESENCE_CHANGED =
  'preferences.messaging-privacy.share-presence-changed';

export interface MessagingPrivacySharePresenceChangedEvent {
  userId: string;
  sharePresence: boolean;
}
