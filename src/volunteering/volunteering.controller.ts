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
import { DecideSignupDto } from './dto/decide-signup.dto';
import { ListOpportunitiesQuery } from './dto/list-opportunities.query';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { VolunteeringService } from './volunteering.service';
import {
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

@Feature('volunteering')
@ApiTags('Volunteering')
@ApiCookieAuth()
@Controller('volunteering')
@UseGuards(ActiveMemberGuard)
export class VolunteeringController {
  constructor(private readonly volunteeringService: VolunteeringService) {}

  @Get()
  @ApiOperation({ summary: 'List volunteering opportunities' })
  @ApiOkResponse({ description: 'Opportunity cards matching the query.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@Query() query: ListOpportunitiesQuery) {
    return this.volunteeringService.list(query);
  }

  @Get('mine')
  @ApiOperation({ summary: 'List opportunities you posted, with applicant counts' })
  @ApiOkResponse({ description: 'Opportunities you posted.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.volunteeringService.listMine(user.userId);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get one volunteering opportunity by slug' })
  @ApiOkResponse({ description: 'The opportunity detail.' })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.getBySlug(slug, user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Post a volunteering opportunity' })
  @ApiCreatedResponse({ description: 'The created opportunity detail.' })
  @ApiConflictResponse({ description: 'Could not allocate a unique slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateOpportunityDto,
  ) {
    return this.volunteeringService.create(user.userId, dto);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update an opportunity you posted' })
  @ApiOkResponse({ description: 'The updated opportunity detail.' })
  @ApiForbiddenResponse({
    description: 'Only the poster can update this opportunity.',
  })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateOpportunityDto,
  ) {
    return this.volunteeringService.update(slug, user.userId, dto);
  }

  @Post(':slug/close')
  @ApiOperation({ summary: 'Close an opportunity you posted' })
  @ApiCreatedResponse({ description: 'The closed opportunity.' })
  @ApiForbiddenResponse({
    description: 'Only the poster can close this opportunity.',
  })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  close(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.close(slug, user.userId);
  }

  @Post(':slug/signups')
  @ApiOperation({ summary: 'Sign up for an opportunity' })
  @ApiCreatedResponse({ description: 'The created signup.' })
  @ApiConflictResponse({
    description: 'The opportunity is at capacity, or you already signed up.',
  })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  signup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateSignupDto,
  ) {
    return this.volunteeringService.signup(slug, user.userId, dto);
  }

  @Delete(':slug/signups')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Withdraw your signup from an opportunity' })
  @ApiNoContentResponse({ description: 'Signup withdrawn.' })
  @ApiNotFoundResponse({
    description: 'No opportunity with that slug, or no member profile.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  withdraw(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.volunteeringService.withdraw(slug, user.userId);
  }

  @Get(':slug/signups')
  @ApiOperation({ summary: 'List signups for an opportunity you posted' })
  @ApiOkResponse({ description: "The opportunity's signups." })
  @ApiForbiddenResponse({ description: 'Only the poster can view signups.' })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listSignups(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.volunteeringService.listSignups(slug, user.userId);
  }

  @Patch(':slug/signups/:signupId')
  @ApiOperation({ summary: 'Accept or decline an applicant (poster only)' })
  @ApiOkResponse({ description: 'The updated signup.' })
  @ApiForbiddenResponse({
    description: 'Only the poster can decide on applicants.',
  })
  @ApiConflictResponse({
    description: 'This application was already decided.',
  })
  @ApiNotFoundResponse({ description: 'No opportunity or signup with that id.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  decideSignup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('signupId') signupId: string,
    @Body() dto: DecideSignupDto,
  ) {
    return this.volunteeringService.decideSignup(
      slug,
      signupId,
      user.userId,
      dto.status,
    );
  }
}
