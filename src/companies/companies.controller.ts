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

@Feature('companies')
@Controller('companies')
@UseGuards(ActiveMemberGuard)
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Get()
  list(@Query() query: ListCompaniesQuery) {
    return this.companiesService.list(query);
  }

  @Get(':slug')
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.companiesService.getBySlug(slug, user.userId);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateCompanyDto) {
    return this.companiesService.create(user.userId, dto);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(slug, user.userId, dto);
  }

  @Get(':slug/reviews')
  listReviews(@Param('slug') slug: string, @Query() query: ListCompaniesQuery) {
    return this.companiesService.listReviews(slug, query);
  }

  @Post(':slug/reviews')
  createReview(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.companiesService.createReview(slug, user.userId, dto);
  }
}
