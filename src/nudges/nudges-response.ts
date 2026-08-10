// Matches the LIVE frontend caller `queerpulse/src/app/providers/api/nudges.ts`
// (Personas Phase 5 Task 1b) — `GET /nudges/me` and `POST /nudges/:key/dismiss`
// both return this shape so a dismiss can update the FE's local state in one
// round trip without a second fetch.
export interface MyNudgesResponse {
  dismissedKeys: string[];
  capped: boolean;
}
