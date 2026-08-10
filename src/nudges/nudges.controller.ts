import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NudgesService } from './nudges.service';

// Shared dismissal store for the six persona-discovery "nudge" moments
// (Personas Phase 5 Task 1): each fires at most once and the whole set caps
// at 2 dismissals, cross-device. Always-on member primitive (no `@Feature`
// flag) — mirrors `src/saved/saved.controller.ts`'s shape.
@ApiTags('Nudges')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Requires an authenticated session.' })
@Controller('nudges')
@UseGuards(ActiveMemberGuard)
export class NudgesController {
  constructor(private readonly nudgesService: NudgesService) {}

  @Get('me')
  @ApiOperation({ summary: "The caller's dismissed nudge keys + cap state." })
  @ApiOkResponse({ description: 'Dismissed keys and whether the cap is hit.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  me(@CurrentUser() user: CurrentUserData) {
    return this.nudgesService.myNudges(user.userId);
  }

  // Idempotent upsert; `key` is validated against the fixed nudge-key set in
  // the service (400 on an unknown key).
  @Post(':key/dismiss')
  @ApiOperation({ summary: 'Dismiss a nudge for good (idempotent).' })
  @ApiOkResponse({ description: 'The updated dismissed keys and cap state.' })
  @ApiForbiddenResponse({ description: 'Not an active member.' })
  dismiss(@CurrentUser() user: CurrentUserData, @Param('key') key: string) {
    return this.nudgesService.dismiss(user.userId, key);
  }
}
