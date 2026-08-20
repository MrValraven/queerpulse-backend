import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { AppealSubmitGuard } from '../auth/guards/appeal-submit.guard';
import { CreateAppealDto } from './dto/create-appeal.dto';
import { ModerationService } from './moderation.service';

/**
 * The member-facing half of appeals: submitting one. The moderator-facing
 * half — the queue and the uphold/overturn decision — lives in
 * `ModerationController` (`GET /mod/appeals`, `PATCH /mod/appeals/:id`), behind
 * `RolesGuard`. Kept a separate controller from that one precisely because the
 * guard posture is the opposite: this route must be reachable by a SUSPENDED
 * member, so it uses {@link AppealSubmitGuard} (the deliberate
 * `ActiveMemberGuard` exception) instead of the mod/admin role gate.
 *
 * Frontend contract: `queerpulse/src/features/safety/api/appeals.api.ts`.
 */
@ApiTags('Appeals')
@ApiCookieAuth()
@Controller('appeals')
@UseGuards(AppealSubmitGuard)
export class AppealsController {
  constructor(private readonly moderationService: ModerationService) {}

  // Tight per-user cap, mirroring `ReportsController.create`: a member has no
  // legitimate reason to file appeals in a burst, and this blunts a suspended
  // account being used to flood the appeals queue.
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post()
  @ApiOperation({ summary: 'Submit an appeal against a moderation decision' })
  @ApiCreatedResponse({ description: 'The appeal was recorded.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'The referenced moderation action is not one you can appeal.',
  })
  @ApiConflictResponse({
    description: 'You already have an appeal awaiting review.',
  })
  submit(@CurrentUser() user: CurrentUserData, @Body() dto: CreateAppealDto) {
    return this.moderationService.submitAppeal(user.userId, dto);
  }

  // The member-facing complement to `submit` above: checking on an appeal
  // already filed. Deep-linked from the enforcement/appeal-resolved
  // notifications and polled by `AppealOutcomePage` (frontend) so a member
  // sees their REAL status rather than a stale demo toggle. Same guard as
  // `submit` — a suspended member is exactly who needs to check on this.
  @Get('me')
  @ApiOperation({ summary: "List the calling member's own appeals" })
  @ApiOkResponse({
    description: "The member's own appeals, most recent first.",
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.moderationService.listMine(user.userId);
  }
}
