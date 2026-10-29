import { EntityManager } from 'typeorm';

/*
 * Studio purchases (contract 4.6): what a buyer's account erasure does to
 * the purchases they made. The artist keeps the sale as "Deleted account"
 * with its amount and date; the payer name and the wall choice go, and a
 * pending claim is cancelled so the artist never sees one nobody can answer.
 * The `buyer_user_id` foreign key then sets the column to null when the user
 * row is deleted.
 *
 * `$1` is the member. Runs inside the erasure transaction, before the user
 * row goes.
 */
export const BUYER_PURCHASES_ERASURE_SQL = `UPDATE "studio_purchases"
   SET "payer_name" = NULL,
       "is_on_wall" = false,
       "is_shown_as_persona" = false,
       "shown_as_subprofile_id" = NULL,
       "status" = CASE WHEN "status" = 'pending' THEN 'cancelled'::studio_purchase_status ELSE "status" END,
       "decided_at" = COALESCE("decided_at", now()),
       "updated_at" = now()
 WHERE "buyer_user_id" = $1`;

/** Clears the payer name and the wall choice of every purchase the member
 *  made and cancels the ones still pending. */
export async function forgetBuyerPurchaseDetails(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  await manager.query(BUYER_PURCHASES_ERASURE_SQL, [userId]);
}
