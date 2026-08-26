// The privacy policy version the client pins consent to. Used only as the
// fallback `policyVersion` in `GET /consent/me` when the caller has never
// consented; a real POST always carries its own `policyVersion`.
//
// Re-exported from `policy-versions.ts`, which is now the ONE place any policy
// revision is declared (see the essay there). Kept as a named export from this
// file so existing importers (`ConsentController`, its spec) are untouched.
export { CURRENT_PRIVACY_POLICY_VERSION as CURRENT_POLICY_VERSION } from './policy-versions';
