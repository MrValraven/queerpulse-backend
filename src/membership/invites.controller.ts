import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CreateInviteDto } from './dto/create-invite.dto';
import { PaginationQuery } from './dto/pagination.query';
import { InviteQuotaView, PublicInviteView } from './invite-response';
import { InvitesService } from './invites.service';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@ApiTags('Membership')
@ApiCookieAuth()
@Controller('invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: 'Mint a personal invite for the current member' })
  @ApiCreatedResponse({ description: 'The newly created invite.' })
  @ApiForbiddenResponse({ description: 'Monthly invite quota exceeded.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateInviteDto) {
    return this.invitesService.createInvite(user.userId, {
      email: dto.email,
      note: dto.note,
      vouch: dto.vouch,
    });
  }

  @Get()
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: "List the current member's own invites" })
  @ApiOkResponse({ description: "Paginated page of the member's invites." })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  list(@CurrentUser() user: CurrentUserData, @Query() page: PaginationQuery) {
    return this.invitesService.listMyInvites(user.userId, page);
  }

  @Get('quota')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: "Get the current member's monthly invite quota" })
  @ApiOkResponse({ description: 'The invite quota and remaining allowance.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  quota(@CurrentUser() user: CurrentUserData): Promise<InviteQuotaView> {
    return this.invitesService.getQuota(user.userId);
  }

  // Public, unauthenticated: the recipient's landing page resolves their invite
  // link before they have an account. Returns only limited, non-sensitive fields
  // and a computed status; unknown codes 404 (treated as invalid by the client).
  //
  // NOTE: `POST /invites/:code/accept` used to live here and has been REMOVED.
  // It was unreachable by construction: it required a JWT, and the only way to
  // hold a JWT is to already have an account — which you can only get by
  // redeeming an invite through Google sign-up, where
  // `AuthService.validateOrCreateGoogleUser` already claims it via
  // `validateInviteForSignup` + `claimInvite`. Its remaining precondition
  // (`redeemer.status === 'pending'`) referenced a state that no longer exists.
  // Redemption happens exactly once, at signup.
  // Throttled per IP (matches PublicProfilesController): unauthenticated and
  // enumerable, so cap probing that would otherwise turn this into a
  // valid-vs-invalid invite-code oracle. The global bucket alone is too loose.
  @Public()
  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Get(':code')
  @ApiOperation({ summary: 'Resolve an invite code for the recipient landing page' })
  @ApiOkResponse({ description: 'Limited, non-sensitive invite fields with a computed status.' })
  @ApiNotFoundResponse({ description: 'No invite with that code.' })
  resolve(@Param('code') code: string): Promise<PublicInviteView> {
    return this.invitesService.resolveInvite(code);
  }
}
