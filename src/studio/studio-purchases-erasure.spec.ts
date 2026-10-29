import { EntityManager } from 'typeorm';
import {
  BUYER_PURCHASES_ERASURE_SQL,
  forgetBuyerPurchaseDetails,
} from './studio-purchases-erasure';

const USER_ID = 'd1400000-0000-4000-8000-000000000001';

describe('Studio buyer purchases erasure', () => {
  let query: jest.Mock;

  beforeEach(() => {
    query = jest.fn().mockResolvedValue([]);
  });

  const asManager = (): EntityManager =>
    ({ query }) as unknown as EntityManager;

  it('clears the payer name and the wall choice and cancels pending claims of the member', async () => {
    await forgetBuyerPurchaseDetails(asManager(), USER_ID);

    expect(query.mock.calls).toEqual([
      [BUYER_PURCHASES_ERASURE_SQL, [USER_ID]],
    ]);
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(`"payer_name" = NULL`);
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(
      `CASE WHEN "status" = 'pending' THEN 'cancelled'::studio_purchase_status ELSE "status" END`,
    );
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(
      `"decided_at" = COALESCE("decided_at", now())`,
    );
    expect(BUYER_PURCHASES_ERASURE_SQL).toMatch(
      /WHERE "buyer_user_id" = \$1\s*$/,
    );
  });

  it('clears the wall choice columns and keeps the sale rows', () => {
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(`"is_on_wall" = false`);
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(
      `"is_shown_as_persona" = false`,
    );
    expect(BUYER_PURCHASES_ERASURE_SQL).toContain(
      `"shown_as_subprofile_id" = NULL`,
    );
    expect(BUYER_PURCHASES_ERASURE_SQL).not.toMatch(/\bDELETE\b/);
  });
});
