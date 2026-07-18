import { Controller, Get, Param, Res } from '@nestjs/common';
import { seconds, Throttle } from '@nestjs/throttler';
import { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PublicProfileResponse } from './public-profile-response';
import { PublicProfilesService } from './public-profiles.service';

/**
 * 🔴 THE FIRST UNAUTHENTICATED ENDPOINT IN THIS API THAT SERVES MEMBER DATA.
 *
 * Every other `@Public()` route is infrastructure — OAuth callbacks, refresh /
 * logout, the Mux webhook, `GET /invites/:code`, `POST /join-requests`,
 * `GET /csrf-token`, `/health*`. None of them return a member's profile. This
 * one does, to anyone, with no account and no invite. The gate lives in
 * `PublicProfilesService.getBySlug` and the published field set in
 * `public-profile-response.ts`; read both before changing anything here.
 */
@Controller('public/profiles')
export class PublicProfilesController {
  constructor(private readonly publicProfilesService: PublicProfilesService) {}

  /**
   * `@Public()` opts out of `JwtAuthGuard` only. The global `CsrfGuard` already
   * treats GET as a safe method, and `LaunchedFeaturesGuard` only acts on
   * routes carrying a `@Feature(...)` tag, so neither needs anything here.
   *
   * ---------------------------------------------------------------------------
   * THROTTLE: 30 requests / 60s, keyed BY IP
   * ---------------------------------------------------------------------------
   * Slugs are usernames derived from real names, so they are guessable and this
   * endpoint is inherently enumerable: a scraper can walk plausible handles and
   * use the 200-vs-404 split to build a membership list of an invite-only queer
   * community. That is the threat, and it is a safety threat, not a capacity
   * one.
   *
   * IP is the only key available — an anonymous caller has no user to track.
   * `HttpThrottlerGuard` does not override `getTracker`, so it inherits
   * `ThrottlerGuard`'s default, which is `req.ip` (verified in
   * @nestjs/throttler 6.5.0); `main.ts` sets `trust proxy` to 1, so behind the
   * expected single proxy that resolves to the real client address rather than
   * the proxy's. `UserPresignThrottlerGuard` exists precisely because it needed
   * to override that default; this route wants it.
   *
   * 30/min is well below the global 120/60s default and cuts a single-address
   * scraper from ~172k to ~43k probes a day, while leaving real browsing
   * untouched — a person reading public profiles opens a handful a minute, and
   * the ceiling still absorbs a burst of tabs and their avatar/asset requests
   * (which are served by object storage, not this API, so they do not count).
   * It is deliberately not lower: shared NAT/CGNAT puts many unrelated people
   * behind one address, and a tight limit would lock out an entire office or
   * mobile carrier before it meaningfully inconvenienced an attacker with a
   * proxy pool.
   *
   * Be honest about the ceiling: IP throttling slows enumeration, it does not
   * prevent it. A distributed scraper defeats it. The real protection is that
   * un-published members are invisible here at all, and that the response for
   * "no such slug" is byte-identical to the response for "exists but not
   * published" — see below.
   */
  @Public()
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @Get(':slug')
  async getBySlug(
    @Param('slug') slug: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicProfileResponse> {
    // `Cache-Control: no-store`, set BEFORE the lookup so it lands on the 404
    // path too — not via `@Header()`, which only decorates a successful
    // response. Both directions need it:
    //
    //   - Un-publishing must take effect immediately. A member toggling the
    //     switch off (or deactivating, or requesting deletion) is often doing
    //     it because something has gone wrong for them, and "your profile stays
    //     readable for another N minutes while a CDN expires it" is the wrong
    //     answer to that. There is no TTL short enough to be worth the risk
    //     against a caching layer we do not control and cannot purge.
    //   - A 404 is heuristically cacheable under RFC 9111 even with no explicit
    //     freshness header, so an uncached 404 could otherwise outlive the
    //     member turning publication ON.
    //
    // If this endpoint ever needs edge caching for load, the correct shape is a
    // cache that the un-publish write can actively purge, not a TTL guess here.
    res.setHeader('Cache-Control', 'no-store');

    // NOT-FOUND, NEVER FORBIDDEN. A 403 would confirm that the slug belongs to
    // a real member who has chosen not to be public — leaking exactly the fact
    // being protected, and handing an enumerator a clean signal to separate
    // "no such person" from "member of this community". The service raises one
    // `NotFoundException` with one message for every rejection reason, so the
    // status line, body and headers are identical whether the slug is unknown,
    // unpublished, deactivated, suspended, or not `visibility = open`.
    //
    // Blocks are deliberately NOT consulted here, and that reasoning holds: a
    // block is directional between two identified members, and an anonymous
    // caller has no identity to be on either side of one. There is nobody to
    // filter, and reading the block graph from an unauthenticated request would
    // add a lookup that cannot change the answer. Note the consequence rather
    // than pretending otherwise — a blocked member can view a published profile
    // by signing out. That is inherent to publishing to the open web, it is
    // what the member opted into, and the remedy is the publication switch,
    // not a filter that a logged-out browser trivially bypasses.
    return this.publicProfilesService.getBySlug(slug);
  }
}
