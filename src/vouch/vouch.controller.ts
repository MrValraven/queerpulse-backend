import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Throttle, seconds } from '@nestjs/throttler';
import { CreateVouchDto } from './dto/create-vouch.dto';
import { VouchService } from './vouch.service';

@Controller('members')
@UseGuards(ActiveMemberGuard)
export class VouchController {
  constructor(private readonly vouchService: VouchService) {}

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':slug/vouch')
  vouch(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateVouchDto,
  ) {
    return this.vouchService.createVouch(user.userId, slug, dto.note);
  }

  @Delete(':slug/vouch')
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.vouchService.withdrawVouch(user.userId, slug);
  }

  @Get(':slug/vouchers')
  vouchers(@Param('slug') slug: string) {
    return this.vouchService.listVouchers(slug);
  }
}

@Controller('me/vouches')
@UseGuards(ActiveMemberGuard)
export class MyVouchesController {
  constructor(private readonly vouchService: VouchService) {}

  @Get('given')
  given(@CurrentUser() user: CurrentUserData) {
    return this.vouchService.listGiven(user.userId);
  }
}
