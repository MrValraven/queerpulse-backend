import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CardScanLogService } from './card-scan-log.service';

/**
 * How often a community's cards have been checked, for the owner and mod
 * panel. Owner-or-mod is enforced inside `CardScanLogService`, the way every
 * other issuer read in this module enforces it.
 *
 * Its own controller rather than another route on `CommunityCardsController`:
 * this is one read with one dependency, and the two share the same
 * `communities/:slug/card` prefix without colliding (`verifications` is not a
 * path any route on that controller claims).
 *
 * The response is an aggregate and stays one. There is no per-member endpoint
 * here and there must never be one: a log of where a member showed their card
 * is exactly the behavioural record the card design forbids.
 */
@Controller('communities/:slug/card')
@UseGuards(ActiveMemberGuard)
export class CommunityCardVerificationsController {
  constructor(private readonly scanLog: CardScanLogService) {}

  @Get('verifications')
  counts(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.scanLog.countsForCommunity(slug, user.userId);
  }
}
