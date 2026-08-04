import {
  Body,
  Controller,
  Delete,
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
import {
  InviteQuotaView,
  MyInviteView,
  PublicInviteView,
} from './invite-response';
import { InvitesService } from './invites.service';
import {
  ApiConflictResponse,
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

  // Throttled per IP on top of the monthly quota: the quota (default 5) bounds
  // successful mints, but a quota-exceeded attempt is a cheap 403 the quota
  // never rate-limits, so cap the burst here the same way the other write
  // routes do (auth/refresh uses 10/60s).
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Mint a personal invite for the current member' })
  @ApiCreatedResponse({ description: 'The newly created invite.' })
  @ApiForbiddenResponse({ description: 'Monthly invite quota exceeded.' })
  @ApiConflictResponse({
    description: 'The email address is on the erasure suppression list.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
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
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() page: PaginationQuery) {
    return this.invitesService.listMyInvites(user.userId, page);
  }

  @Get('quota')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: "Get the current member's monthly invite quota" })
  @ApiOkResponse({ description: 'The invite quota and remaining allowance.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  quota(@CurrentUser() user: CurrentUserData): Promise<InviteQuotaView> {
    return this.invitesService.getQuota(user.userId);
  }

  // Cancel one of the member's own still-pending invites, addressed by the code
  // its invite list already exposes. Idempotent for an already-revoked invite;
  // 403 if it isn't theirs; 409 once it has been accepted or expired. Returns
  // the updated invite row (same shape as GET /). Shares the `:code` path with
  // the public GET resolve route, but the DELETE verb + ActiveMemberGuard keep
  // the two apart.
  @Delete(':code')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({
    summary: "Revoke one of the current member's pending invites",
  })
  @ApiOkResponse({ description: 'The revoked invite.' })
  @ApiForbiddenResponse({
    description: 'The invite belongs to another member.',
  })
  @ApiNotFoundResponse({ description: 'No invite with that code.' })
  @ApiConflictResponse({
    description: 'The invite has already been accepted or expired.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  revoke(
    @CurrentUser() user: CurrentUserData,
    @Param('code') code: string,
  ): Promise<MyInviteView> {
    return this.invitesService.revokeInvite(user.userId, code);
  }

  // Re-mint one of the member's OWN expired invites, addressed by the code its
  // invite list exposes: refreshes the same row's expiry and flips it back to
  // pending so the original link works again. Quota-neutral (the same
  // invitation, not a new slot). 403 if it isn't theirs; 404 if unknown; 409 if
  // it was accepted, revoked, or is still valid — only an expired invite is
  // resendable. Returns the updated invite row (same shape as GET /). Throttled
  // per IP to match the create route's write posture.
  @Post(':code/resend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Resend (re-mint) one of the current member's expired invites",
  })
  @ApiOkResponse({ description: 'The refreshed invite.' })
  @ApiForbiddenResponse({
    description: 'The invite belongs to another member.',
  })
  @ApiNotFoundResponse({ description: 'No invite with that code.' })
  @ApiConflictResponse({
    description:
      'The invite was accepted or revoked, or is still valid — only an expired invite is resendable.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  resend(
    @CurrentUser() user: CurrentUserData,
    @Param('code') code: string,
  ): Promise<MyInviteView> {
    return this.invitesService.resendInvite(user.userId, code);
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
  @ApiOperation({
    summary: 'Resolve an invite code for the recipient landing page',
  })
  @ApiOkResponse({
    description: 'Limited, non-sensitive invite fields with a computed status.',
  })
  @ApiNotFoundResponse({ description: 'No invite with that code.' })
  resolve(@Param('code') code: string): Promise<PublicInviteView> {
    return this.invitesService.resolveInvite(code);
  }
}
