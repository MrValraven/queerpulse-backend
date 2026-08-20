import { IsOptional, IsString, MaxLength } from 'class-validator';

// `GET /admin/trust-network/search` query — the typeahead behind the graph
// modal's "find a member" search box (ADM-10). `q` is a free-text name/handle
// term; mirrors `AdminMediaUploadersQueryDto`.
export class SearchTrustNetworkMembersQuery {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;
}
