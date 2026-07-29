import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Throttle, seconds } from '@nestjs/throttler';
import { CreateReportDto } from './dto/create-report.dto';
import { ListReasonsQuery } from './dto/list-reasons.query';
import { ReportsService } from './reports.service';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';

// Always-on safety infrastructure (no `@Feature` gate, like `blocks`/`mutes`)
// — any active member can file a report or read the reason taxonomy.
// Frontend contract: `queerpulse/src/features/safety/api/reports.api.ts`.
@ApiTags('Reports')
@ApiCookieAuth()
@Controller('reports')
@UseGuards(ActiveMemberGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  // Tight per-user cap on report filing (mirrors `VouchController`): a member
  // has no legitimate reason to file more than a handful of reports a minute,
  // and this blunts spam/abuse-report floods.
  @Throttle({ default: { limit: 10, ttl: seconds(60) } })
  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateReportDto) {
    return this.reportsService.create(user.userId, dto);
  }

  @Get('reasons')
  reasons(@Query() query: ListReasonsQuery) {
    return this.reportsService.reasonsFor(query.subjectType);
  }
}
