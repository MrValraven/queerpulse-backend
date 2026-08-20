/**
 * Minimal, hand-mapped responses for the newsletter endpoints. Deliberately
 * carry only a status — never the email or confirm token — so the public
 * responses leak nothing about who is on the list or which token confirms it.
 */

/** Response for `POST /newsletter/subscribe` — always identical shape. */
export interface SubscribeResultDto {
  /** Always `'pending'`: a fresh subscribe is unconfirmed until the link is opened. */
  status: 'pending';
}

/** Response for `GET /newsletter/confirm`. */
export interface ConfirmResultDto {
  status: 'confirmed';
}

/**
 * Response for `GET /newsletter/unsubscribe`. `alreadyUnsubscribed`
 * distinguishes a no-op re-visit from a fresh transition purely so the
 * confirmation page can show honest copy ("you're unsubscribed" vs "you were
 * already unsubscribed") — it doesn't open a new enumeration surface, since
 * reaching this response at all already requires holding a valid token.
 */
export interface UnsubscribeResultDto {
  status: 'unsubscribed';
  alreadyUnsubscribed: boolean;
}
