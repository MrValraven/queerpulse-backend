import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { UpdateMyCardDto } from './dto/update-my-card.dto';
import { toRenewedCard } from './membership-card-response';
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
   * the issuing community controls on the programme: whether their photo and
   * their pronouns appear on it. Both are absent-leaves-it-alone, so a client
   * may send either on its own.
   */
  @Patch(':cardId')
  async update(
    @CurrentUser() user: CurrentUserData,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Body() dto: UpdateMyCardDto,
  ) {
    await this.cards.updateOwnCardSettings(cardId, user.userId, {
      isPhotoHidden: dto.isPhotoHidden,
      isPronounsHidden: dto.isPronounsHidden,
    });
    return { ok: true };
  }

  /**
   * Put the caller's own card back in date near its expiry (SUS-07), without
   * an owner running the roster bulk issue.
   *
   * Every condition is enforced in the service, on live data: the programme
   * has to allow self renewal, the caller has to still be on the roster, the
   * card has to be ACTIVE (a suspended or revoked one was withdrawn by an
   * issuer and only an issuer can undo that), and the term has to be inside
   * its last thirty days. Each refusal carries a `reasonCode` so the page can
   * say which one it was instead of showing a generic failure.
   *
   * 200, not 201: this creates nothing. It moves one card's expiry, and
   * calling it twice leaves the same single term in place.
   */
  @Post(':cardId/renew')
  @HttpCode(200)
  async renew(
    @CurrentUser() user: CurrentUserData,
    @Param('cardId', ParseUUIDPipe) cardId: string,
  ) {
    const { card, effectiveStatus } = await this.cards.renewOwnCard(
      cardId,
      user.userId,
    );
    return toRenewedCard(card, effectiveStatus);
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
    @Param('cardId', ParseUUIDPipe) cardId: string,
  ) {
    await this.cards.deleteOwnCard(cardId, user.userId);
    return { ok: true };
  }
}
