import {
  Body,
  Controller,
  Get,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AuditLogQuery } from './dto/audit-log.query';
import { ListModReportsQuery } from './dto/list-mod-reports.query';
import { ModActionDto } from './dto/mod-action.dto';
import { ModBulkActionDto } from './dto/mod-bulk-action.dto';
import { ReviewAppealDto } from './dto/review-appeal.dto';
import { ModerationService } from './moderation.service';

// Moderator/admin only. Frontend contract:
// `queerpulse/src/features/admin/api/moderation.api.ts`.
@Controller('mod')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class ModerationController {
  constructor(private readonly moderationService: ModerationService) {}

  @Get('reports')
  listReports(@Query() query: ListModReportsQuery) {
    return this.moderationService.list(query);
  }

  // Static path registered before `:id` so `/mod/reports/audit` never gets
  // swallowed by the `:id` param route (mirrors the usual Nest routing
  // pitfall guard other controllers avoid the same way).
  @Get('reports/audit')
  audit(@Query() query: AuditLogQuery) {
    return this.moderationService.auditTrail(query.reportId);
  }

  @Get('reports/:id')
  getReport(@Param('id', ParseUUIDPipe) id: string) {
    return this.moderationService.getById(id);
  }

  @Patch('reports/:id')
  updateReport(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ModActionDto,
  ) {
    return this.moderationService.actOnReport(id, user.userId, dto);
  }

  @Post('reports/bulk')
  bulkUpdateReports(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ModBulkActionDto,
  ) {
    return this.moderationService.bulkActOnReports(user.userId, dto);
  }

  @Get('appeals')
  listAppeals() {
    return this.moderationService.listAppeals();
  }

  @Patch('appeals/:id')
  reviewAppeal(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewAppealDto,
  ) {
    return this.moderationService.reviewAppeal(id, user.userId, dto);
  }
}
