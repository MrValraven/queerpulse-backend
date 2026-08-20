import { IsOptional, IsString, MaxLength } from 'class-validator';

// `GET /admin/trust-network` query. `focus` pins one profile (by slug) into
// the returned node set even when their join date falls outside the
// MAX_NODES newest-first cutoff — so opening the graph for a specific member
// (from AdminMemberDrawer, or after picking a `search` result) never renders
// "not found" just because they joined a while ago (ADM-10).
export class GetTrustNetworkQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  focus?: string;
}
