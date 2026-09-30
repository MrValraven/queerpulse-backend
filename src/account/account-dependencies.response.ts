// Matches the frontend's `AccountDependencies` lists in
// `features/members/api/useAccountDependencies.ts` (minus its client-side
// `isLoading`/`isError`/`hasDependencies` flags). Returned by
// `GET /account/dependencies`.

/** A community the caller owns, by roster role. */
export interface AccountDependencyCommunityResponse {
  slug: string;
  name: string;
}

/** A directory listing the caller owns whose moderation status is live. */
export interface AccountDependencyListingResponse {
  ref: string;
  name: string;
}

export interface AccountDependenciesResponse {
  communities: AccountDependencyCommunityResponse[];
  listings: AccountDependencyListingResponse[];
}
