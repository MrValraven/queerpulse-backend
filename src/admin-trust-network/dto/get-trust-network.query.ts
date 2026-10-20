import { IsOptional, IsString, MaxLength } from 'class-validator';

// `GET /admin/trust-network` query. `focus` (a profile slug) centres the
// graph on one member: they come first in the node set, followed by their
// vouch neighbours up to BFS_MAX_DEPTH hops, and the newest members fill any
// space left under MAX_NODES. Opening the graph for a specific member (from
// AdminMemberDrawer, or after picking a `search` result) therefore always
// shows them and their own connections, whatever their join date (ADM-10).
// Without `focus` the graph shows the newest members.
export class GetTrustNetworkQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  focus?: string;
}
