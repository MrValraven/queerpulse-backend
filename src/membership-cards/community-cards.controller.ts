import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CardHoldersService } from './card-holders.service';
import { CardProgramsService } from './card-programs.service';
import { SetCardStatusDto } from './dto/revoke-card.dto';
import { UpsertCardProgramDto } from './dto/upsert-card-program.dto';
import { toCardProgram } from './membership-card-response';
import { MembershipCardsService } from './membership-cards.service';

@Controller('communities/:slug/card')
@UseGuards(ActiveMemberGuard)
export class CommunityCardsController {
  constructor(
    private readonly programs: CardProgramsService,
    private readonly cards: MembershipCardsService,
    private readonly cardHolders: CardHoldersService,
  ) {}

  /** Any member may read the programme: it is what their own card looks like. */
  @Get()
  async get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    const program = await this.programs.getBySlug(slug, user.userId);
    return program ? toCardProgram(program) : null;
  }

  /** Owner or mod only, enforced inside the service. */
  @Put()
  async upsert(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpsertCardProgramDto,
  ) {
    const program = await this.programs.upsert(slug, user.userId, dto);
    return toCardProgram(program);
  }

  @Post('issue-all')
  async issueAll(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    const issued = await this.cardHolders.issueForCommunity(slug, user.userId);
    return { issued };
  }

  @Get('holders')
  holders(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.cardHolders.listForCommunity(slug, user.userId);
  }

  @Patch('holders/:cardId')
  async setStatus(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('cardId') cardId: string,
    @Body() dto: SetCardStatusDto,
  ) {
    await this.cards.setStatus(
      slug,
      user.userId,
      cardId,
      dto.status,
      dto.reason,
    );
    return { ok: true };
  }
}
