import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { Feature } from '../common/feature.decorator';
import { CreateOpportunityDto } from './dto/create-opportunity.dto';
import { CompleteSignupDto } from './dto/complete-signup.dto';
import { CreateSignupDto } from './dto/create-signup.dto';
import { DecideSignupDto } from './dto/decide-signup.dto';
import { ListOpportunitiesQuery } from './dto/list-opportunities.query';
import { UpdateOpportunityDto } from './dto/update-opportunity.dto';
import { VolunteeringService } from './volunteering.service';
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

// The class guard is `ActiveMemberGuard`, so everything here is member-only
// unless a handler says otherwise with `@Public()`. TWO reads do: the
// opportunity LIST and the opportunity DETAIL.
//
// `/about/volunteer` and each opportunity's detail page are deliberately
// public in the frontend's `authGate.ts` — anyone can see what the platform
// needs help with, and that is the whole acquisition argument for the page.
// The data behind them therefore has to answer an anonymous caller too:
// `ActiveMemberGuard` rejected before the handler ran, so every logged-out
// visitor got a "could not load, retry" panel that retrying never fixed.
//
// `@Public()` is enough on its own: `ActiveMemberGuard` reads the same
// `IS_PUBLIC_KEY` the global `JwtAuthGuard` does (see its constructor comment)
// and steps aside per handler, so a class-level binding does NOT have to be
// unpicked. The detail read additionally carries `OptionalJwtAuthGuard`
// because it is the one read here that is caller-specific: `isPoster` and
// `mySignup` need `req.user` populated when there IS a session, and left
// undefined when there is not.
//
// Everything that WRITES — posting, editing, closing, signing up, withdrawing,
// deciding on an applicant, confirming a session — and every read of a
// caller's own data (`mine`, `me/contribution`, `:slug/signups`) stays behind
// the class guard.
@Feature('volunteering')
@ApiTags('Volunteering')
@ApiCookieAuth()
@Controller('volunteering')
@UseGuards(ActiveMemberGuard)
export class VolunteeringController {
  constructor(private readonly volunteeringService: VolunteeringService) {}

  @Public()
  @Get()
  @ApiOperation({
    summary: 'List volunteering opportunities (unauthenticated)',
  })
  @ApiOkResponse({
    description:
      'Opportunity cards matching the query. `OpportunityCardDTO` carries ' +
      'no caller-specific field, so the anonymous and member responses are ' +
      'identical.',
  })
  list(@Query() query: ListOpportunitiesQuery) {
    return this.volunteeringService.list(query);
  }

  @Get('mine')
  @ApiOperation({
    summary:
      'List opportunities you can review applicants for, with applicant counts',
  })
  @ApiOkResponse({
    description:
      'Opportunities you posted, plus those attributed to a community you own or moderate.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listMine(@CurrentUser() user: CurrentUserData) {
    return this.volunteeringService.listMine(user.userId);
  }

  @Get('me/contribution')
  @ApiOperation({
    summary: 'Your own confirmed volunteer sessions and hours',
  })
  @ApiOkResponse({
    description:
      'Sessions a poster confirmed you attended, the hours they attested, and how many accepted signups are still waiting on a confirmation.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  myContribution(@CurrentUser() user: CurrentUserData) {
    return this.volunteeringService.myContribution(user.userId);
  }

  // Public, with best-effort auth. The two caller-specific flags on the
  // detail (`isPoster`, `mySignup`) come back false for an anonymous reader
  // rather than crashing or, worse, being computed against an undefined id —
  // see `VolunteeringService.buildDetail`, which skips the signup lookup
  // entirely when there is no viewer.
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':slug')
  @ApiOperation({
    summary: 'Get one volunteering opportunity by slug (unauthenticated)',
  })
  @ApiOkResponse({
    description:
      'The opportunity detail. `isPoster` and `mySignup` are both false for ' +
      'an anonymous caller.',
  })
  @ApiNotFoundResponse({ description: 'No opportunity with that slug.' })
  get(
    // Populated best-effort by `OptionalJwtAuthGuard`; undefined when anonymous.
    @CurrentUser() user: CurrentUserData | undefined,
    @Param('slug') slug: string,
  ) {
    return this.volunteeringService.getBySlug(slug, user?.userId ?? null);
  }

  @Post()
  @UseGuards(NotRestrictedGuard)
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
  @UseGuards(NotRestrictedGuard)
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
  @UseGuards(NotRestrictedGuard)
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
  @ApiNotFoundResponse({
    description: 'No opportunity or signup with that id.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  decideSignup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('signupId', ParseUUIDPipe) signupId: string,
    @Body() dto: DecideSignupDto,
  ) {
    return this.volunteeringService.decideSignup(
      slug,
      signupId,
      user.userId,
      dto.status,
    );
  }

  @Post(':slug/signups/:signupId/complete')
  @ApiOperation({
    summary:
      'Confirm an accepted volunteer turned up, and for how long (poster or community organiser)',
  })
  @ApiCreatedResponse({ description: 'The completed signup.' })
  @ApiBadRequestResponse({ description: 'Hours outside 0..24.' })
  @ApiForbiddenResponse({
    description:
      'Only the poster or a community organiser can confirm sessions, and never their own.',
  })
  @ApiConflictResponse({
    description:
      'The application was not accepted, or the session was already confirmed.',
  })
  @ApiNotFoundResponse({
    description: 'No opportunity or signup with that id.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  completeSignup(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Param('signupId', ParseUUIDPipe) signupId: string,
    @Body() dto: CompleteSignupDto,
  ) {
    return this.volunteeringService.confirmCompletion(
      slug,
      signupId,
      user.userId,
      {
        attended: dto.attended,
        hours: dto.hours,
      },
    );
  }
}
