import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNotFoundResponse,
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
import { CreateSafeSpaceVouchDto } from './dto/create-safe-space-vouch.dto';
import { SafeSpaceVouchesService } from './safe-space-vouches.service';

/**
 * Member-facing safe-space vouch writes — the write half mirroring
 * `VouchController`. A space is addressed by its listing SLUG, matching the
 * public read path (`GET /directory/safe-spaces/:slug`). Auth is the class-level
 * `ActiveMemberGuard` on top of the global JWT guard — no `@Public()`.
 */
@ApiTags('Safe-space vouches')
@ApiCookieAuth()
@Controller('safe-spaces')
@UseGuards(ActiveMemberGuard)
export class SafeSpaceVouchesController {
  constructor(private readonly safeSpaceVouches: SafeSpaceVouchesService) {}

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':slug/vouch')
  @ApiOperation({ summary: 'Vouch for a verified safe space' })
  @ApiCreatedResponse({ description: 'The updated live vouch count.' })
  @ApiBadRequestResponse({
    description: 'This space is not a verified safe space.',
  })
  @ApiConflictResponse({
    description: 'You have already vouched for this space.',
  })
  @ApiNotFoundResponse({ description: 'No safe space with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  vouch(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSafeSpaceVouchDto,
  ) {
    return this.safeSpaceVouches.createVouch(user.userId, slug, {
      note: dto.note,
      relationship: dto.relationship,
      anonymous: dto.anonymous,
    });
  }

  @Delete(':slug/vouch')
  @ApiOperation({ summary: 'Withdraw your vouch for a safe space' })
  @ApiOkResponse({ description: 'Vouch withdrawn.' })
  @ApiNotFoundResponse({
    description: 'No safe space with that slug, or no vouch to withdraw.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.safeSpaceVouches.withdrawVouch(user.userId, slug);
  }
}
