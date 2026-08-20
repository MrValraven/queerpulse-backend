import {
  Body,
  Controller,
  Delete,
  Get,
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
import { Throttle, seconds } from '@nestjs/throttler';
import { CreateVouchDto } from './dto/create-vouch.dto';
import { PaginationQuery } from './dto/pagination.query';
import { VouchService } from './vouch.service';
import {
  ApiBadRequestResponse,
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

@ApiTags('Vouches')
@ApiCookieAuth()
@Controller('members')
@UseGuards(ActiveMemberGuard)
export class VouchController {
  constructor(private readonly vouchService: VouchService) {}

  @Throttle({ default: { limit: 20, ttl: seconds(60) } })
  @Post(':slug/vouch')
  @ApiOperation({ summary: 'Vouch for a member' })
  @ApiCreatedResponse({ description: 'The created vouch.' })
  @ApiBadRequestResponse({ description: 'You cannot vouch for yourself.' })
  @ApiConflictResponse({
    description: 'You have already vouched for this member.',
  })
  @ApiForbiddenResponse({
    description: "You've reached your daily vouch limit.",
  })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  vouch(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateVouchDto,
  ) {
    return this.vouchService.createVouch(user.userId, slug, {
      note: dto.note,
      relationships: dto.relationships,
      anonymous: dto.anonymous,
    });
  }

  @Delete(':slug/vouch')
  @ApiOperation({ summary: 'Withdraw your vouch for a member' })
  @ApiOkResponse({ description: 'Vouch withdrawn.' })
  @ApiNotFoundResponse({
    description: 'No member with that slug, or no vouch to withdraw.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.vouchService.withdrawVouch(user.userId, slug);
  }

  @Get(':slug/vouchers')
  @ApiOperation({
    summary: 'List members who vouched for a member (paginated)',
  })
  @ApiOkResponse({ description: 'A page of vouchers.' })
  @ApiNotFoundResponse({ description: 'No member with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  vouchers(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Query() page: PaginationQuery,
  ) {
    return this.vouchService.listVouchers(slug, page, user.userId);
  }
}

@ApiTags('Vouches')
@ApiCookieAuth()
@Controller('me/vouches')
@UseGuards(ActiveMemberGuard)
export class MyVouchesController {
  constructor(private readonly vouchService: VouchService) {}

  @Get('given')
  @ApiOperation({
    summary: 'List the vouches the current member has given (paginated)',
  })
  @ApiOkResponse({ description: 'A page of vouches the member has given.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  given(@CurrentUser() user: CurrentUserData, @Query() page: PaginationQuery) {
    return this.vouchService.listGiven(user.userId, page);
  }
}
