// The privacy policy version the client pins consent to (see the frontend's
// `POLICY_VERSION` in `queerpulse/src/shared/api/consent.api.ts`). Used only as
// the fallback `policyVersion` in `GET /consent/me` when the caller has never
// consented; a real POST always carries its own `policyVersion`.
export const CURRENT_POLICY_VERSION = '3.3';
