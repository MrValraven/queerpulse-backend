import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { GenesisService } from './genesis.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * One-time platform bootstrap. See `GenesisService` for the gate model.
 *
 * `@LockdownExempt()` for the same reason `AuthController` carries it: the
 * global `PlatformLockdownGuard` 503s anonymous callers while a lockdown is on,
 * which would make bootstrap impossible on a locked platform. Note this only
 * unblocks MINTING — redemption still runs through
 * `validateOrCreateGoogleUser`, which rejects new accounts during a lockdown or
 * with registration disabled. Both default correctly on a fresh deploy.
 */
@LockdownExempt()
@ApiTags('Genesis')
@Controller('genesis')
export class GenesisController {
  constructor(private readonly genesis: GenesisService) {}

  /**
   * Public for the same reason as `invite`: the founder has no account yet.
   * The genesis page calls this on every load to decide whether to offer the
   * flow at all, so it gets a looser bucket than the POSTs. It only reads.
   */
  @Public()
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Get('status')
  @ApiOperation({ summary: 'Whether genesis is still open' })
  @ApiOkResponse({
    description:
      '`{ open: boolean }`. False once genesis is disabled, consumed, or any admin exists.',
    schema: {
      type: 'object',
      properties: { open: { type: 'boolean' } },
      required: ['open'],
    },
  })
  status(): Promise<{ open: boolean }> {
    return this.genesis.getStatus();
  }

  /**
   * Public by necessity — the founder has no account yet, so there is no
   * credential to present. Safe because the minted invite is pinned to
   * `GENESIS_EMAIL` and nobody else can redeem it.
   */
  @Public()
  // Tighter than the global 120/min/IP bucket. Bootstrap is a handful of
  // clicks by one person, so anything above a few per minute is a stranger
  // probing the route and paying us three queries per probe.
  @Throttle({ default: { limit: 3, ttl: seconds(60) } })
  @Post('invite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mint the one-time genesis (founder) invite' })
  @ApiOkResponse({ description: 'The redeemable genesis invite code.' })
  @ApiNotFoundResponse({
    description: 'Genesis is disabled or the platform is already bootstrapped.',
  })
  invite(): Promise<{ code: string }> {
    return this.genesis.mintGenesisInvite();
  }

  @Throttle({ default: { limit: 3, ttl: seconds(60) } })
  @Post('claim')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ActiveMemberGuard)
  @ApiCookieAuth('access_token')
  @ApiOperation({
    summary: 'Promote the genesis account to admin (self-closing)',
  })
  @ApiNoContentResponse({ description: 'Caller promoted to admin.' })
  @ApiUnauthorizedResponse({
    description: 'Not authenticated as an active member.',
  })
  @ApiForbiddenResponse({
    description:
      'Body carries `code`: `genesis_not_founder_account` for the wrong account, `genesis_closed` once genesis is closed.',
  })
  @ApiNotFoundResponse({ description: 'Genesis is disabled.' })
  claim(@CurrentUser() user: CurrentUserData): Promise<void> {
    return this.genesis.claimAdmin(user.userId, user.email);
  }
}
