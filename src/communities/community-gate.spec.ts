import {
  GATED_ACCESS_TIERS,
  gatedAccessTiersSqlLiteralList,
  isGatedTier,
} from './community-gate';
import { AccessTier } from './entities/community.entity';

describe('GATED_ACCESS_TIERS', () => {
  it('equals every AccessTier that isGatedTier accepts, in enum order', () => {
    expect(GATED_ACCESS_TIERS).toEqual(
      Object.values(AccessTier).filter(isGatedTier),
    );
  });

  it('never lists the public tier', () => {
    expect(GATED_ACCESS_TIERS).not.toContain(AccessTier.Public);
  });

  it('renders the same tiers as a quoted SQL literal list', () => {
    expect(gatedAccessTiersSqlLiteralList()).toBe(
      GATED_ACCESS_TIERS.map((accessTier) => `'${accessTier}'`).join(', '),
    );
  });
});
