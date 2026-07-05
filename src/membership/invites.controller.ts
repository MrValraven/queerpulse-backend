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
import { PublicInviteView } from './invite-response';
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

  // Public, unauthenticated: the recipient's landing page resolves their invite
  // link before they have an account. Returns only limited, non-sensitive fields
  // and a computed status; unknown codes 404 (treated as invalid by the client).
  @Public()
  @Get(':code')
  resolve(@Param('code') code: string): Promise<PublicInviteView> {
    return this.invitesService.resolveInvite(code);
  }

  // pending-ok: a pending user redeems an invite (no ActiveMemberGuard).
  @Post(':code/accept')
  async accept(
    @CurrentUser() user: CurrentUserData,
    @Param('code') code: string,
  ): Promise<{ ok: true }> {
    await this.invitesService.acceptInvite(code, {
      userId: user.userId,
      email: user.email,
    });
    return { ok: true };
  }
}
