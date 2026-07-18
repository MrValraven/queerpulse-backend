import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { DiscoverableIdentitiesService } from './discoverable-identities.service';
import { UpdateDiscoverableIdentitiesDto } from './dto/update-discoverable-identities.dto';

/**
 * Which of the member's identities are published for member-directory search.
 * `GET|PUT /me/discoverable-identities`.
 *
 * ---------------------------------------------------------------------------
 * GUARDS: JWT only — deliberately NO ActiveMemberGuard
 * ---------------------------------------------------------------------------
 * Following `src/preferences/preferences.controller.ts` exactly, and for a
 * sharper version of the same reason. `ActiveMemberGuard` 403s anyone whose
 * `users.status` is not `active`, which since
 * `AddDeactivatedStatus1782800710000` includes every deactivated member. Adding
 * it here would mean a member who deactivates can no longer UN-PUBLISH the fact
 * that they are trans, or disabled, or a lesbian — a disclosure they can switch
 * on but not off is a trap, and "I am stepping back from this community" is very
 * often the exact moment someone needs to retract one.
 *
 * Note the sibling route in `profiles.controller.ts` (`GET /profiles/:slug`) DOES
 * carry `ActiveMemberGuard`, and correctly: browsing other members is a feature.
 * Retracting your own disclosure is not a feature, it is a safety control.
 *
 * Read and write are treated the same, on purpose — a read-only exception would
 * leave a deactivated member staring at a list of published identities they
 * cannot change, which is worse than not showing it at all.
 *
 * This is only the write side of the switch. What makes un-publishing actually
 * instant is that nothing derives or caches from this column: the directory
 * filter reads `profiles.discoverable_identities` live on every query
 * (`ProfilesService.searchMembers`), so the next search after a PUT already
 * reflects it. Do not add a cache here without solving invalidation first — a
 * retraction that takes effect in five minutes is a retraction that did not
 * work.
 */
@Controller('me')
export class DiscoverableIdentitiesController {
  constructor(
    private readonly discoverableIdentities: DiscoverableIdentitiesService,
  ) {}

  // Returns `{ available, published }` — what this member could publish, and
  // what they have. Empty `published` for anyone who has never opted in, which
  // is everyone by default.
  @Get('discoverable-identities')
  get(@CurrentUser() user: CurrentUserData) {
    return this.discoverableIdentities.get(user.userId);
  }

  // Full replace; `{ identities: [] }` un-publishes everything. Echoes the
  // persisted state back so the client renders what was actually stored rather
  // than what it optimistically sent. 422 when an identity is not one the member
  // has declared privately.
  @Put('discoverable-identities')
  update(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: UpdateDiscoverableIdentitiesDto,
  ) {
    return this.discoverableIdentities.update(user.userId, dto);
  }
}
