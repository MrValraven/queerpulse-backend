/**
 * How many URLs one `GET /link-preview/batch` call may carry.
 *
 * Four is deliberately small. A batch is a round-trip saver, never a bigger
 * budget: every URL in it costs one slot in the same rate bucket a single
 * unfurl draws from (see `LinkPreviewThrottlerGuard`), so a batch of four and
 * four separate calls spend exactly the same allowance. Keeping the cap low
 * also bounds the outbound work one request can start: four sockets, each with
 * the fetcher's own 4-second timeout and 512 KB body cap.
 */
export const MAX_BATCH_URLS = 4;

/**
 * The product surfaces whose members may unfurl a link.
 *
 * Unfurling is a shared utility rather than a feature of its own: messaging
 * pastes links into DMs, the forum pastes them into threads and replies, and
 * the feed surfaces both. The endpoint stays reachable while ANY of these is
 * launched, and 404s (the same answer `LaunchedFeaturesGuard` gives) only once
 * every surface that can paste a link is off.
 */
export const LINK_PREVIEW_SURFACES = ['messaging', 'forum', 'feed'] as const;

/**
 * How many URLs one MEMBER may unfurl per `UNFURL_WINDOW_SECONDS`.
 *
 * Sized against reading rather than against a request budget. A feed page of
 * twenty cards carrying twenty distinct links costs twenty slots, a forum
 * thread with a handful costs a handful, and the client spends the same
 * allowance whether it asks one URL at a time or four per batch (see the
 * per-URL accounting in `LinkPreviewThrottlerGuard`). 150 therefore covers
 * about seven full pages of entirely new links inside one minute, which is
 * faster than anybody reads, so a member scrolling hard never meets it.
 *
 * The previous number was 40, chosen while the bucket was keyed on client IP
 * and so had to be shared by everyone behind one venue's wifi. It was too tight
 * even for one member on their own connection: two feed scrolls spent it and
 * the third got 429s. Keying per member removes the shared-venue penalty and
 * lets the number be sized for a single pair of eyes.
 *
 * It is still a throttle, and what it stops is this endpoint being used as a
 * general outbound fetcher. A crawl or a port-scan-by-unfurl from one account
 * runs at 2.5 URLs a second, needs a live vouched active membership to run at
 * all, and is named in the bucket key, which makes it slower and far more
 * traceable than doing the same thing from anywhere else. Slots are charged
 * before the service consults its 10-minute cache, so a link somebody already
 * unfurled costs allowance while costing no outbound fetch: the real fetch rate
 * behind this number is lower than the number.
 */
export const UNFURL_URL_LIMIT = 150;

/**
 * The window `UNFURL_URL_LIMIT` is measured over. One minute, matching every
 * other bucket in the app, so a member who does hit the limit waits an amount
 * of time the rest of the product has already taught them.
 */
export const UNFURL_WINDOW_SECONDS = 60;
