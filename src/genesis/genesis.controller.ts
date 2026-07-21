import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { GenesisService } from './genesis.service';

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
@Controller('genesis')
export class GenesisController {
  constructor(private readonly genesis: GenesisService) {}

  /**
   * Public by necessity — the founder has no account yet, so there is no
   * credential to present. Safe because the minted invite is pinned to
   * `GENESIS_EMAIL` and nobody else can redeem it.
   */
  @Public()
  @Post('invite')
  @HttpCode(HttpStatus.OK)
  invite(): Promise<{ code: string }> {
    return this.genesis.mintGenesisInvite();
  }

  @Post('claim')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ActiveMemberGuard)
  claim(@CurrentUser() user: CurrentUserData): Promise<void> {
    return this.genesis.claimAdmin(user.userId, user.email);
  }
}
