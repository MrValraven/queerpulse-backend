import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CardTokenService } from './card-token.service';
import { UpdateMyCardDto } from './dto/update-my-card.dto';
import { MembershipCardsService } from './membership-cards.service';
import { MyCardsService } from './my-cards.service';

@Controller('me/cards')
@UseGuards(ActiveMemberGuard)
export class MembershipCardsController {
  constructor(
    private readonly myCards: MyCardsService,
    private readonly cards: MembershipCardsService,
    private readonly tokens: CardTokenService,
  ) {}

  @Get()
  list(@CurrentUser() user: CurrentUserData) {
    return this.myCards.forUser(user.userId);
  }

  /**
   * Mint a fresh 60 second proof token for one of the caller's OWN cards.
   * A POST rather than a GET because it mints a credential: it must never be
   * cached by a browser, a proxy, or a service worker.
   */
  @Post(':cardId/token')
  async token(
    @CurrentUser() user: CurrentUserData,
    @Param('cardId') cardId: string,
  ) {
    const card = await this.cards.cardById(cardId);
    // 404 rather than 403 for someone else's card: never confirm that a card
    // id exists to a caller who does not hold it.
    if (!card || card.userId !== user.userId) {
      throw new NotFoundException('Card not found');
    }
    // Refuse to mint for anything but an active card. Revocation is instant
    // (spec §B) and must invalidate in-flight tokens; minting a fresh signed
    // token for a revoked/suspended/expired card would contradict that, and
    // is exactly what Phase 2's offline door queue (which validates
    // signatures without a server round trip) would wrongly accept. Same
    // 404 as above: the caller learns nothing about why.
    const status = await this.cards.resolveEffectiveStatus(card);
    if (status !== 'active') {
      throw new NotFoundException('Card not found');
    }
    return this.tokens.mint(card.id);
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
