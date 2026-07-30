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
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

/**
 * Member-facing housing listings. `GET/PATCH/DELETE /housing-listings/:ref`
 * are owner-gated (the caller's own submission-tracking view; 403 for a
 * non-owner ref) — public browse is `HousingDirectoryController`. `mine` is
 * declared before `:ref` so Nest resolves the literal segment first.
 */
@Feature('housingListings')
@ApiTags('Housing')
@ApiCookieAuth()
@Controller('housing-listings')
@UseGuards(ActiveMemberGuard)
export class HousingListingsController {
  constructor(private readonly service: HousingListingsService) {}

  @Post()
  @ApiOperation({ summary: 'Create a housing listing for the current member' })
  @ApiCreatedResponse({ description: 'The newly created housing listing.' })
  @ApiConflictResponse({ description: 'Could not allocate a unique listing reference.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateHousingListingDto,
  ) {
    return this.service.create(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "List the current member's own housing listings" })
  @ApiOkResponse({ description: "Paginated page of the member's housing listings." })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  listMine(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListMyHousingListingsQuery,
  ) {
    return this.service.listMine(user.userId, query);
  }

  @Get(':ref')
  @ApiOperation({ summary: "Get one of the member's own housing listings by reference" })
  @ApiOkResponse({ description: 'The housing listing owned by the caller.' })
  @ApiNotFoundResponse({ description: 'No housing listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  get(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.service.getByRef(ref, user.userId);
  }

  @Patch(':ref')
  @ApiOperation({ summary: "Update one of the member's own housing listings" })
  @ApiOkResponse({ description: 'The updated housing listing.' })
  @ApiNotFoundResponse({ description: 'No housing listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: UpdateHousingListingDto,
  ) {
    return this.service.update(ref, user.userId, dto);
  }

  @Delete(':ref')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete one of the member's own housing listings" })
  @ApiNoContentResponse({ description: 'The housing listing was deleted.' })
  @ApiNotFoundResponse({ description: 'No housing listing with that reference.' })
  @ApiForbiddenResponse({ description: 'The listing is not owned by the caller.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  remove(@CurrentUser() user: CurrentUserData, @Param('ref') ref: string) {
    return this.service.remove(ref, user.userId);
  }

  @Post(':ref/enquiries')
  @ApiOperation({ summary: "Send an enquiry to a live listing's lister" })
  @ApiCreatedResponse({ description: 'The conversation id for the delivered enquiry.' })
  @ApiNotFoundResponse({ description: 'No live housing listing with that reference.' })
  @ApiBadRequestResponse({ description: 'Cannot send an enquiry on your own listing.' })
  @ApiUnauthorizedResponse({ description: 'Not an authenticated active member.' })
  enquire(
    @CurrentUser() user: CurrentUserData,
    @Param('ref') ref: string,
    @Body() dto: CreateHousingEnquiryDto,
  ) {
    return this.service.createEnquiry(ref, user.userId, dto);
  }
}
