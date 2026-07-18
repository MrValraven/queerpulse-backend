import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { UpdatePublicProfileDto } from './dto/update-public-profile.dto';
import { UpdateWorkPreferencesDto } from './dto/update-work-preferences.dto';
import { PreferencesService } from './preferences.service';

/**
 * Member safety + visibility switches. Mirrors the frontend contract exactly:
 * `GET|PUT /me/work-preferences`, `GET|PUT /me/public-profile`.
 *
 * ---------------------------------------------------------------------------
 * GUARDS: JWT only — deliberately NO ActiveMemberGuard
 * ---------------------------------------------------------------------------
 * Sibling `/me/*` routes (`src/saved/saved.controller.ts`) do add
 * `ActiveMemberGuard`, but those are member FEATURES: a deactivated account
 * losing its bookmarks list is correct.
 *
 * These are safety controls, and the asymmetry matters. `ActiveMemberGuard`
 * 403s anyone whose `users.status` is not `active`, which since
 * `AddDeactivatedStatus1782800710000` includes every deactivated member. Adding
 * it here would mean a member who deactivates can no longer turn their public
 * profile OFF, nor retract an outness disclosure — the exact moment those
 * controls matter most is the moment the guard would take them away. A setting
 * you can switch on but not off is a trap, and "I am stepping back from this
 * community" is a reason to grant more control over your disclosures, not less.
 *
 * So this follows the precedent `src/account/account.controller.ts` documents
 * for account lifecycle, consent and email preferences: authentication is
 * required (the global `JwtAuthGuard` covers that — these routes are not
 * `@Public()`), membership status is not. Reads and writes are treated the same
 * on purpose; a read-only exception would leave the member staring at a setting
 * they cannot change.
 */
@Controller('me')
export class PreferencesController {
  constructor(private readonly preferencesService: PreferencesService) {}

  // Returns defaults (`verified` / `[]` / `true`) when no row exists yet rather
  // than 404 — see `PreferencesService.loadOrDefault`.
  @Get('work-preferences')
  getWorkPreferences(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getWorkPreferences(user.userId);
  }

  // Full replace, echoing the persisted state back so the client renders what
  // was actually stored (normalised) rather than what it optimistically sent.
  @Put('work-preferences')
  updateWorkPreferences(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateWorkPreferencesDto,
  ) {
    return this.preferencesService.updateWorkPreferences(user.userId, body);
  }

  // Defaults to `{ enabled: false }` when no row exists — off unless the member
  // has said otherwise.
  @Get('public-profile')
  getPublicProfile(@CurrentUser() user: CurrentUserData) {
    return this.preferencesService.getPublicProfile(user.userId);
  }

  @Put('public-profile')
  updatePublicProfile(
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdatePublicProfileDto,
  ) {
    return this.preferencesService.updatePublicProfile(user.userId, body);
  }
}
