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

@Controller('invites')
export class InvitesController {
  constructor(private readonly invitesService: InvitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(ActiveMemberGuard)
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateInviteDto) {
    return this.invitesService.createInvite(user.userId, {
      email: dto.email,
      note: dto.note,
      vouch: dto.vouch,
    });
  }

  @Get()
  @UseGuards(ActiveMemberGuard)
  list(@CurrentUser() user: CurrentUserData, @Query() page: PaginationQuery) {
    return this.invitesService.listMyInvites(user.userId, page);
  }

  @Get('quota')
  @UseGuards(ActiveMemberGuard)
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
  @Public()
  @Get(':code')
  resolve(@Param('code') code: string): Promise<PublicInviteView> {
    return this.invitesService.resolveInvite(code);
  }
}
