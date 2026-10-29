/**
 * Studio landing v2 (contract 2.2): the generation of the in-process landing
 * memo. `StudioLandingReadService.getPublicLanding` keeps one built payload
 * for `STUDIO_LANDING_MEMO_MILLISECONDS`, tagged with the generation it read
 * when the build started, and serves it only while the generation still
 * matches. A build that started before a write therefore never serves as
 * current.
 *
 * It exists as a plain module holding one integer so every writer can bump it
 * without a Studio provider: the subprofiles module (a persona unlink, inside
 * its transaction) and every landing writer call `invalidateStudioLandingMemo`
 * directly, and no writer injects `StudioLandingReadService`. It imports
 * nothing. Like the `ThrottlerModule` storage, it is per process.
 */

export const STUDIO_LANDING_MEMO_MILLISECONDS = 60_000;

let memoGeneration = 0;

/** The generation a landing build reads when it starts. */
export function studioLandingMemoGeneration(): number {
  return memoGeneration;
}

/** Called after every landing write resolves: the next read rebuilds. */
export function invalidateStudioLandingMemo(): void {
  memoGeneration += 1;
}

/** Restores the starting generation so specs do not leak into one another. */
export function resetStudioLandingMemoForTesting(): void {
  memoGeneration = 0;
}
