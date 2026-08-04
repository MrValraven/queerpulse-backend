import {
  Body,
  Controller,
  Get,
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
import { CompaniesService } from './companies.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CreateReviewDto } from './dto/create-review.dto';
import { ListCompaniesQuery } from './dto/list-companies.query';
import { UpdateCompanyDto } from './dto/update-company.dto';
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

@Feature('companies')
@ApiTags('Companies')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({
  description: 'Requires an authenticated, active member session.',
})
@Controller('companies')
@UseGuards(ActiveMemberGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  @ApiOperation({ summary: 'List companies (paginated).' })
  @ApiOkResponse({ description: 'A page of company cards.' })
  list(@Query() query: ListCompaniesQuery) {
    return this.companiesService.list(query);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a company by slug.' })
  @ApiOkResponse({ description: 'The company detail.' })
  @ApiNotFoundResponse({ description: 'No company with that slug.' })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.companiesService.getBySlug(slug, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a company.' })
  @ApiCreatedResponse({ description: 'The created company detail.' })
  @ApiConflictResponse({ description: 'Could not allocate a unique slug.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateCompanyDto) {
    return this.companiesService.create(user.userId, dto);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a company you own.' })
  @ApiOkResponse({ description: 'The updated company detail.' })
  @ApiForbiddenResponse({
    description: 'Only the owner can update the company.',
  })
  @ApiNotFoundResponse({ description: 'No company with that slug.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(slug, user.userId, dto);
  }

  @Get(':slug/reviews')
  @ApiOperation({ summary: "List a company's reviews (paginated)." })
  @ApiOkResponse({ description: 'A page of company reviews.' })
  @ApiNotFoundResponse({ description: 'No company with that slug.' })
  listReviews(@Param('slug') slug: string, @Query() query: ListCompaniesQuery) {
    return this.companiesService.listReviews(slug, query);
  }

  @Post(':slug/reviews')
  @ApiOperation({ summary: 'Post a review for a company.' })
  @ApiCreatedResponse({ description: 'The created review.' })
  @ApiNotFoundResponse({ description: 'No company with that slug.' })
  @ApiConflictResponse({
    description: 'You have already reviewed this company.',
  })
  createReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.companiesService.createReview(slug, user.userId, dto);
  }
}
