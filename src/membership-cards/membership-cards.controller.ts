import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { UpdateMyCardDto } from './dto/update-my-card.dto';
import { MembershipCardsService } from './membership-cards.service';
import { MyCardsService } from './my-cards.service';

@Controller('me/cards')
@UseGuards(ActiveMemberGuard)
export class MembershipCardsController {
  constructor(
    private readonly myCards: MyCardsService,
    private readonly cards: MembershipCardsService,
  ) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.myCards.forUser(user.userId);
  }

  /**
   * The settings the HOLDER controls on their own card, as against the ones
   * the issuing community controls on the programme. Today that is only
   * whether their photo appears on it.
   */
  @Patch(':cardId')
  async update(
    @CurrentUser() user: CurrentUserData,
    @Param('cardId') cardId: string,
    @Body() dto: UpdateMyCardDto,
  ) {
    await this.cards.setPhotoHidden(cardId, user.userId, dto.isPhotoHidden);
    return { ok: true };
  }

  /**
   * Destroy one of the caller's OWN cards (spec §K.4: the member's right to
   * have a card destroyed, not only revoked). Hard delete, not a status
   * change — a member who leaves a community should be able to make the row
   * disappear from their wallet and their data export, not just revoke it.
   */
  @Delete(':cardId')
  async remove(
    @CurrentUser() user: CurrentUserData,
    @Param('cardId') cardId: string,
  ) {
    await this.cards.deleteOwnCard(cardId, user.userId);
    return { ok: true };
  }
}
