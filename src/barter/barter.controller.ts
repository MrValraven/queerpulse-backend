import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { Feature } from '../common/feature.decorator';
import { BarterService } from './barter.service';
import { CreateBarterListingDto } from './dto/create-barter-listing.dto';
import { CreateBarterProposalDto } from './dto/create-barter-proposal.dto';
import { DecideBarterProposalDto } from './dto/decide-barter-proposal.dto';
import { ListBarterQuery } from './dto/list-barter.query';
import { UpdateBarterListingDto } from './dto/update-barter-listing.dto';

/**
 * The skill exchange: swap listings and the proposals members make against
 * them. Member-gated end to end (`ActiveMemberGuard`), like the jobs board —
 * the marketing shell around the page is public, the board itself is not.
 *
 * Route order matters: `mine` is declared before `:id` so it is never parsed
 * as a listing id.
 */
@Feature('barter')
@ApiTags('Barter')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
@Controller('barter')
@UseGuards(ActiveMemberGuard)
export class BarterController {
  constructor(private readonly barterService: BarterService) {}

  @Get()
  @ApiOperation({ summary: 'List open swap listings, optionally filtered' })
  @ApiOkResponse({ description: 'Paginated page of swap listings.' })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListBarterQuery) {
    return this.barterService.list(user.userId, query);
  }

  @Get('mine')
  @ApiOperation({
    summary: 'List swaps you posted, with their pending proposal counts',
  })
  @ApiOkResponse({ description: 'Your swap listings, newest first.' })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.barterService.listMine(user.userId);
  }

  /**
   * The proposer's own half of the board. Declared HERE, above
   * `:id/proposals`, because Nest matches in declaration order and `mine`
   * would otherwise be read as a listing id (and rejected by `ParseUUIDPipe`
   * as a 400 rather than reaching this handler).
   */
  @Get('mine/proposals')
  @ApiOperation({ summary: 'List the proposals you sent, with their outcomes' })
  @ApiOkResponse({
    description: 'Your sent proposals, newest first, each with its listing.',
  })
  listMySentProposals(@CurrentUser() user: CurrentUserData) {
    return this.barterService.listMySentProposals(user.userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one swap listing' })
  @ApiOkResponse({ description: 'The listing detail.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  get(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.barterService.getById(id, user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post()
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Post a swap to the exchange' })
  @ApiCreatedResponse({ description: 'The created listing.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateBarterListingDto,
  ) {
    return this.barterService.create(user.userId, dto);
  }

  @Patch(':id')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Correct a swap you posted' })
  @ApiOkResponse({ description: 'The updated listing, owner view.' })
  @ApiForbiddenResponse({ description: 'Only the poster can edit it.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBarterListingDto,
  ) {
    return this.barterService.update(id, user.userId, dto);
  }

  @Post(':id/close')
  @ApiOperation({ summary: 'Take one of your swaps off the board' })
  @ApiCreatedResponse({ description: 'The closed listing.' })
  @ApiForbiddenResponse({ description: 'Only the poster can close it.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  close(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.barterService.close(id, user.userId);
  }

  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post(':id/proposals')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: "Propose a swap against someone else's listing" })
  @ApiCreatedResponse({
    description:
      'The created proposal plus the conversation it was delivered into.',
  })
  @ApiForbiddenResponse({
    description: 'Your own listing, or you cannot contact this member.',
  })
  @ApiConflictResponse({
    description: 'The listing is closed, or you already proposed on it.',
  })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  propose(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBarterProposalDto,
  ) {
    return this.barterService.createProposal(id, user.userId, dto);
  }

  @Get(':id/proposals')
  @ApiOperation({ summary: 'List the proposals on a listing you posted' })
  @ApiOkResponse({ description: "The listing's proposals, newest first." })
  @ApiForbiddenResponse({ description: 'Only the poster can see these.' })
  @ApiNotFoundResponse({ description: 'No listing with that id.' })
  listProposals(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.barterService.listProposals(id, user.userId);
  }

  @Patch(':id/proposals/:proposalId')
  @ApiOperation({ summary: 'Accept or decline a proposal (poster only)' })
  @ApiOkResponse({ description: 'The decided proposal.' })
  @ApiForbiddenResponse({ description: 'Only the poster can decide.' })
  @ApiConflictResponse({ description: 'This proposal was already decided.' })
  @ApiNotFoundResponse({ description: 'No listing or proposal with that id.' })
  decideProposal(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('proposalId', ParseUUIDPipe) proposalId: string,
    @Body() dto: DecideBarterProposalDto,
  ) {
    return this.barterService.decideProposal(
      id,
      proposalId,
      user.userId,
      dto.status,
    );
  }
}
