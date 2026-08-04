import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RecognitionService } from './recognition.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * `GET /me/recognition` — the caller's own level, badges and perks (spec §3
 * Tier 2 "recognition"). Frontend contract:
 * `queerpulse/src/features/members/api/recognition.api.ts`.
 */
@ApiTags('Recognition')
@ApiCookieAuth('access_token')
@Controller('me/recognition')
@UseGuards(ActiveMemberGuard)
export class MyRecognitionController {
  constructor(private readonly recognitionService: RecognitionService) {}

  @ApiOperation({ summary: "Get the caller's level, badges, and perks" })
  @ApiOkResponse({
    description: "The caller's recognition, including private perk state.",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @Get()
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.recognitionService.getForUser(user.userId, true);
  }
}

/**
 * `GET /profiles/:slug/recognition` — another member's recognition, resolved
 * by slug. Declared as its own controller (rather than editing
 * `src/profiles/profiles.controller.ts`, which this task must not touch) —
 * NestJS merges routes from multiple controllers sharing the `profiles`
 * prefix across modules, the same way `ProfilesController`/`MembersController`
 * already coexist.
 */
@ApiTags('Recognition')
@ApiCookieAuth('access_token')
@Controller('profiles')
@UseGuards(ActiveMemberGuard)
export class MemberRecognitionController {
  constructor(private readonly recognitionService: RecognitionService) {}

  @ApiOperation({ summary: "Get another member's recognition by slug" })
  @ApiOkResponse({
    description:
      "The member's recognition (perk state omitted for non-owners).",
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid session.' })
  @ApiForbiddenResponse({ description: 'Caller is not an active member.' })
  @ApiNotFoundResponse({ description: 'No profile with that slug.' })
  @Get(':slug/recognition')
  getForMember(@Param('slug') slug: string) {
    return this.recognitionService.getBySlug(slug);
  }
}
