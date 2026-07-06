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

@Feature('jobs')
@Controller('jobs')
@UseGuards(ActiveMemberGuard)
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  list(@Query() query: ListJobsQuery) {
    return this.jobsService.list(query);
  }

  @Get(':slug')
  get(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.jobsService.getBySlug(slug, user.userId);
  }

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateJobDto) {
    return this.jobsService.create(user.userId, dto);
  }

  @Patch(':slug')
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: UpdateJobDto,
  ) {
    return this.jobsService.update(slug, user.userId, dto);
  }

  @Post(':slug/close')
  close(@CurrentUser() user: CurrentUserData, @Param('slug') slug: string) {
    return this.jobsService.close(slug, user.userId);
  }

  @Post(':slug/applications')
  apply(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
    @Body() dto: CreateJobApplicationDto,
  ) {
    return this.jobsService.apply(slug, user.userId, dto);
  }

  @Get(':slug/applications')
  listApplications(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.jobsService.listApplications(slug, user.userId);
  }
}

@Feature('jobs')
@Controller('me')
@UseGuards(ActiveMemberGuard)
export class MeApplicationsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get('applications')
  myApplications(@CurrentUser() user: CurrentUserData) {
    return this.jobsService.listMyApplications(user.userId);
  }
}
