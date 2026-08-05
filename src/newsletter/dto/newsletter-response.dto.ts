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
