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
import { CreateJobApplicationDto } from './dto/create-application.dto';
import { CreateJobDto } from './dto/create-job.dto';
import { ListJobsQuery } from './dto/list-jobs.query';
import { UpdateJobDto } from './dto/update-job.dto';
import { JobsService } from './jobs.service';
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

@Feature('jobs')
@ApiTags('Jobs')
@ApiCookieAuth()
@Controller('jobs')
@UseGuards(ActiveMemberGuard)
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  @ApiOperation({ summary: 'List job postings, optionally filtered' })
  @ApiOkResponse({ description: 'Paginated page of job cards.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  list(@CurrentUser() user: CurrentUserData, @Query() query: ListJobsQuery) {
    return this.jobsService.list(query, user.role);
  }

  @Get(':slug')
  @ApiOperation({ summary: 'Get a job posting by slug' })
  @ApiOkResponse({ description: 'The job detail.' })
  @ApiNotFoundResponse({ description: 'No job with that slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.jobsService.getBySlug(slug, user.userId, user.role);
  }

  @Post()
  @ApiOperation({ summary: 'Create a job posting' })
  @ApiCreatedResponse({ description: 'The newly created job detail.' })
  @ApiBadRequestResponse({
    description:
      'Company reference was neither an existing company nor a new-company name.',
  })
  @ApiNotFoundResponse({
    description: 'The referenced company does not exist.',
  })
  @ApiConflictResponse({ description: 'Could not allocate a unique job slug.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateJobDto) {
    return this.jobsService.create(user.userId, dto);
  }

  @Patch(':slug')
  @ApiOperation({ summary: 'Update a job posting (poster only)' })
  @ApiOkResponse({ description: 'The updated job detail.' })
  @ApiNotFoundResponse({ description: 'No job with that slug.' })
  @ApiForbiddenResponse({ description: 'Only the poster can update this job.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateJobDto,
  ) {
    return this.jobsService.update(slug, user.userId, dto);
  }

  @Post(':slug/close')
  @ApiOperation({ summary: 'Close a job posting (poster only)' })
  @ApiCreatedResponse({ description: 'The closed job detail.' })
  @ApiNotFoundResponse({ description: 'No job with that slug.' })
  @ApiForbiddenResponse({ description: 'Only the poster can close this job.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  close(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.jobsService.close(slug, user.userId);
  }

  @Post(':slug/applications')
  @ApiOperation({ summary: 'Apply to a job posting' })
  @ApiCreatedResponse({ description: 'The created job application.' })
  @ApiNotFoundResponse({ description: 'No job with that slug.' })
  @ApiConflictResponse({ description: 'You have already applied to this job.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  apply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateJobApplicationDto,
  ) {
    return this.jobsService.apply(slug, user.userId, dto);
  }

  @Get(':slug/applications')
  @ApiOperation({
    summary: 'List applications for a job posting (poster only)',
  })
  @ApiOkResponse({ description: "The job's applications." })
  @ApiNotFoundResponse({ description: 'No job with that slug.' })
  @ApiForbiddenResponse({
    description: 'Only the poster can view applications.',
  })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  listApplications(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.jobsService.listApplications(slug, user.userId);
  }
}

@Feature('jobs')
@ApiTags('Jobs')
@ApiCookieAuth()
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class MeApplicationsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('applications')
  @ApiOperation({ summary: "List the current member's own job applications" })
  @ApiOkResponse({ description: "The member's job applications." })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  myApplications(@CurrentUser() user: CurrentUserData) {
    return this.jobsService.listMyApplications(user.userId);
  }

  @Get('jobs')
  @ApiOperation({ summary: "List the current member's own job postings" })
  @ApiOkResponse({ description: "Paginated page of the member's job cards." })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  myJobs(@CurrentUser() user: CurrentUserData, @Query() query: ListJobsQuery) {
    return this.jobsService.listMine(user.userId, query);
  }
}
