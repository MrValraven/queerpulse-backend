import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { BootstrapService } from './bootstrap.service';

/**
 * Session bootstrap — the profile / saved / blocks / mutes slices in one round
 * trip, replacing four parallel requests on every page load.
 *
 * `ActiveMemberGuard` because all four underlying endpoints require it. No
 * `@Feature` flag: like blocks/mutes/saved, this is an always-on primitive.
 */
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @Get('bootstrap')
  get(@CurrentUser() user: CurrentUserData) {
    return this.bootstrap.getForUser(user.userId);
  }
}
