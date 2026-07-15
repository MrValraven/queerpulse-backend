import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CommissionInterestsService } from './commission-interests.service';
import { CreateCommissionInterestDto } from './dto/create-commission-interest.dto';

// The Culture page (`CulturePage.tsx`) is almost entirely curated editorial
// content (book/film/music club picks, the art showcase gallery, community
// radio) with no server-backed listing of its own. The one genuine piece of
// member-submitted data on the page is expressing interest in a Commission
// Board project (`CommissionInterestModal.tsx`) — this controller is that,
// and only that.
@Feature('culture')
@Controller('commissions')
@UseGuards(ActiveMemberGuard)
export class CommissionInterestsController {
  constructor(
    private readonly commissionInterestsService: CommissionInterestsService,
  ) {}

  @Post('interest')
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateCommissionInterestDto,
  ) {
    return this.commissionInterestsService.create(user.userId, dto);
  }
}
