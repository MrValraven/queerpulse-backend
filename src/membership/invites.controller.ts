import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Public } from '../auth/decorators/public.decorator';
import { CreateInviteDto } from './dto/create-invite.dto';
import { ListMyInvitesQuery } from './dto/list-my-invites.query';
import { UpdateInvitePrivateNoteDto } from './dto/update-invite-private-note.dto';
import {
  InviteQuotaView,
  MyInviteCountsView,
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
  //
  // ENG-496: an email-pinned mint answers the same for every well-formed
  // address, so the route reveals nothing about who once had an account. See
  // `InvitesService.createInvite`.
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({ summary: 'Mint a personal invite for the current member' })
  @ApiCreatedResponse({ description: 'The newly created invite.' })
  @ApiForbiddenResponse({
    description:
      'Monthly invite quota exceeded — body carries code "INVITE_QUOTA_EXCEEDED".',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateInviteDto) {
    return this.invitesService.createInvite(user.userId, {
      email: dto.email,
      note: dto.note,
      vouch: dto.vouch,
      privateNote: dto.privateNote,
    });
  }

  @Get()
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: "List the current member's own invites" })
  @ApiOkResponse({
    description:
      "Paginated page of the member's invites, optionally filtered by status.",
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyInvitesQuery,
  ) {
    return this.invitesService.listMyInvites(user.userId, query, query.status);
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

  // The true per-tab totals behind GET /'s `?status=` filter tabs, so a tab can
  // show its full count while the list itself pages in.
  @Get('counts')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({ summary: "Count the current member's invites per status" })
  @ApiOkResponse({
    description: 'Totals for all, valid, used, expired, and revoked invites.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  counts(@CurrentUser() user: CurrentUserData): Promise<MyInviteCountsView> {
    return this.invitesService.countMyInvites(user.userId);
  }

  // Cancel one of the member's own still-pending invites, addressed by the code
  // its invite list already exposes. Idempotent for an already-revoked invite;
  // 404 if it isn't theirs OR doesn't exist (deliberately the same answer, so
  // the route can't be used to test whether a code exists); 409 once it has
  // been accepted or expired. Returns the updated invite row (same shape as
  // GET /). Shares the `:code` path with the public GET resolve route, but the
  // DELETE verb + ActiveMemberGuard keep the two apart.
  @Delete(':code')
  @UseGuards(ActiveMemberGuard)
  @ApiOperation({
    summary: "Revoke one of the current member's pending invites",
  })
  @ApiOkResponse({ description: 'The revoked invite.' })
  @ApiNotFoundResponse({
    description: 'No invite with that code belongs to the caller.',
  })
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
  // invitation, not a new slot). 404 if it isn't theirs or is unknown (one
  // answer for both, so the route reveals nothing about other members' codes);
  // 409 if it was accepted, revoked, or is still valid — only an expired invite
  // is resendable. Returns the updated invite row (same shape as GET /). Throttled
  // per IP to match the create route's write posture.
  @Post(':code/resend')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveMemberGuard, NotRestrictedGuard)
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @ApiOperation({
    summary: "Resend (re-mint) one of the current member's expired invites",
  })
  @ApiOkResponse({ description: 'The refreshed invite.' })
  @ApiNotFoundResponse({
    description: 'No invite with that code belongs to the caller.',
  })
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

  // Set or clear the member's own private note on one of their invites (their
  // label for who it is for), addressed by the code its invite list exposes.
  // Works on every status, since the label changes nothing about the invite.
  // 404 if it isn't theirs or is unknown (one answer for both, matching
  // revoke). ActiveMemberGuard only: a private label reaches nobody else, so a
  // restricted member may still keep their own list tidy. Returns the updated
  // invite row (same shape as GET /).
  @Patch(':code/private-note')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ActiveMemberGuard)
  @Throttle({ default: { limit: 30, ttl: seconds(60) } })
  @ApiOperation({
    summary:
      "Set or clear the private note on one of the current member's invites",
  })
  @ApiOkResponse({ description: 'The invite with its updated private note.' })
  @ApiNotFoundResponse({
    description: 'No invite with that code belongs to the caller.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  updatePrivateNote(
    @CurrentUser() user: CurrentUserData,
    @Param('code') code: string,
    @Body() dto: UpdateInvitePrivateNoteDto,
  ): Promise<MyInviteView> {
    return this.invitesService.updatePrivateNote(
      user.userId,
      code,
      dto.privateNote,
    );
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
