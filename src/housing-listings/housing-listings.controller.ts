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
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateHousingEnquiryDto } from './dto/create-housing-enquiry.dto';
import { CreateHousingListingDto } from './dto/create-housing-listing.dto';
import { ListMyHousingListingsQuery } from './dto/list-my-housing-listings.query';
import { UpdateHousingListingDto } from './dto/update-housing-listing.dto';
import { HousingListingsService } from './housing-listings.service';

/**
 * Member-facing housing listings. `GET/PATCH/DELETE /housing-listings/:ref`
 * are owner-gated (the caller's own submission-tracking view; 403 for a
 * non-owner ref) — public browse is `HousingDirectoryController`. `mine` is
 * declared before `:ref` so Nest resolves the literal segment first.
 */
@Feature('housingListings')
@Controller('housing-listings')
@UseGuards(ActiveMemberGuard)
export class HousingListingsController {
  constructor(private readonly service: HousingListingsService) {}

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateHousingListingDto,
  ) {
    return this.service.create(user.userId, dto);
  }

  @Get('mine')
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyHousingListingsQuery,
  ) {
    return this.service.listMine(user.userId, query);
  }

  @Get(':ref')
  get(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.service.getByRef(ref, user.userId);
  }

  @Patch(':ref')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateHousingListingDto,
  ) {
    return this.service.update(ref, user.userId, dto);
  }

  @Delete(':ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.service.remove(ref, user.userId);
  }

  @Post(':ref/enquiries')
  enquire(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: CreateHousingEnquiryDto,
  ) {
    return this.service.createEnquiry(ref, user.userId, dto);
  }
}
