import { ArrayMaxSize, IsArray, IsIn } from 'class-validator';
import { PUBLISHABLE_INTEREST_LABELS } from '../identities';

/**
 * A full REPLACE of the published set — consistent with the other `PUT /me/*`
 * and `PUT /profiles/me/*` endpoints, and the right shape for this one in
 * particular: `{ identities: [] }` is how a member un-publishes everything at
 * once, and a merge/patch shape would have no way to say it.
 *
 * `@IsIn(PUBLISHABLE_INTEREST_LABELS)` range-checks the VOCABULARY only. The
 * subset invariant — you may only publish an identity you actually hold — needs
 * the member's stored `identities` and so cannot be expressed here; it is
 * enforced in `DiscoverableIdentitiesService.update` (422) and by the
 * `CHK_profiles_discoverable_subset` database constraint. Not required is
 * deliberate: omitting the field is not a way to leave the set alone.
 */
export class UpdateDiscoverableIdentitiesDto {
  @IsArray()
  @ArrayMaxSize(30)
  @IsIn(PUBLISHABLE_INTEREST_LABELS, { each: true })
  identities!: string[];
}
