import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CreateListingDto } from './dto/create-listing.dto';
import { ListMyListingsQuery } from './dto/list-my-listings.query';
import { UpdateListingStatusDto } from './dto/update-listing-status.dto';
import { UpdateListingDto } from './dto/update-listing.dto';
import { ListingsService } from './listings.service';

/**
 * Member business directory listings (spec §3 Tier 4 "listings"). Every
 * route but `setStatus` is owner-gated: `GET/PATCH/DELETE /listings/:ref`
 * are the caller's own submission-tracking view (403 for a non-owner ref),
 * not a public directory browse. FE: `listings.api.ts`.
 *
 * `mine` is declared before `:ref` so Nest/Express's route matching resolves
 * `GET /listings/mine` as the literal segment rather than the `:ref` param
 * (mirrors every other domain's "static path before dynamic param" ordering).
 */
@Feature('listings')
@Controller('listings')
@UseGuards(ActiveMemberGuard)
export class ListingsController {
  constructor(private readonly listingsService: ListingsService) {}

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateListingDto) {
    return this.listingsService.create(user.userId, dto);
  }

  @Get('mine')
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyListingsQuery,
  ) {
    return this.listingsService.listMine(user.userId, query);
  }

  @Get(':ref')
  get(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.getByRef(ref, user.userId);
  }

  @Patch(':ref')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateListingDto,
  ) {
    return this.listingsService.update(ref, user.userId, dto);
  }

  @Delete(':ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.listingsService.remove(ref, user.userId);
  }

  // Moderator-only: the FE's `setListingStatus` comment is explicit that
  // this is "NOT called from the member client" — only the moderation
  // surface transitions a listing's status, so this route layers
  // `RolesGuard` on top of the controller's `ActiveMemberGuard`.
  @Patch(':ref/status')
  @UseGuards(RolesGuard)
  @Roles(UserRole.Moderator, UserRole.Admin)
  setStatus(@Param('ref') ref: string, @Body() dto: UpdateListingStatusDto) {
    return this.listingsService.setStatus(ref, dto.status);
  }
}
