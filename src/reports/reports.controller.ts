import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CreateReportDto } from './dto/create-report.dto';
import { ListReasonsQuery } from './dto/list-reasons.query';
import { ReportsService } from './reports.service';

// Always-on safety infrastructure (no `@Feature` gate, like `blocks`/`mutes`)
// — any active member can file a report or read the reason taxonomy.
// Frontend contract: `queerpulse/src/features/safety/api/reports.api.ts`.
@Controller('reports')
@UseGuards(ActiveMemberGuard)
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateReportDto) {
    return this.reportsService.create(user.userId, dto);
  }

  @Get('reasons')
  reasons(@Query() query: ListReasonsQuery) {
    return this.reportsService.reasonsFor(query.subjectType);
  }
}
