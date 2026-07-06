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
import { CreateOpportunityDto } from './dto/create-opportunity.dto';
import { CreateSignupDto } from './dto/create-signup.dto';
import { ListOpportunitiesQuery } from './dto/list-opportunities.query';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { VolunteeringService } from './volunteering.service';

@Feature('volunteering')
@Controller('volunteering')
@UseGuards(ActiveMemberGuard)
export class VolunteeringController {
  constructor(private readonly volunteeringService: VolunteeringService) {}

  @Get()
  list(@Query() query: ListOpportunitiesQuery) {
    return this.volunteeringService.list(query);
  }

  @Get(':slug')
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.getBySlug(slug, user.userId);
  }

  @Post()
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateOpportunityDto,
  ) {
    return this.volunteeringService.create(user.userId, dto);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateOpportunityDto,
  ) {
    return this.volunteeringService.update(slug, user.userId, dto);
  }

  @Post(':slug/close')
  close(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.close(slug, user.userId);
  }

  @Post(':slug/signups')
  signup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSignupDto,
  ) {
    return this.volunteeringService.signup(slug, user.userId, dto);
  }

  @Delete(':slug/signups')
  @HttpCode(HttpStatus.NO_CONTENT)
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.withdraw(slug, user.userId);
  }

  @Get(':slug/signups')
  listSignups(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.volunteeringService.listSignups(slug, user.userId);
  }
}
