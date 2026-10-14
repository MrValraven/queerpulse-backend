import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { DecideStudioDisputeDto } from './dto/decide-studio-dispute.dto';
import { ListAdminStudioDisputesQuery } from './dto/list-admin-studio-disputes.query';
import { StudioReleaseDisputeStatus } from './entities/studio-release-dispute.entity';
import { StudioAdminDispute } from './studio-dispute-response';
import { StudioDisputesService } from './studio-disputes.service';
import { StudioPage } from './studio-response';
import { StudioStaffReadsService } from './studio-staff-reads.service';

// Studio open demo pages: the flag review's Disputes tab. Staff decide an
// artist's dispute about a takedown; no Studio grant needed, like the other
// Studio staff routes.
@Feature('studio')
@ApiTags('Admin: Studio')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/studio/disputes')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminStudioDisputesController {
  constructor(
    private readonly staffReads: StudioStaffReadsService,
    private readonly disputes: StudioDisputesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Disputes by status, newest first.' })
  @ApiOkResponse({ description: '`StudioPage<StudioAdminDispute>`.' })
  listDisputes(
    @Query() query: ListAdminStudioDisputesQuery,
  ): Promise<StudioPage<StudioAdminDispute>> {
    return this.staffReads.listDisputes(
      query.status ?? StudioReleaseDisputeStatus.Open,
      query.cursor,
    );
  }

  @Post(':id/uphold')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Uphold a dispute: restore the release, with a reply.',
  })
  @ApiOkResponse({ description: '`StudioAdminDispute`.' })
  @ApiNotFoundResponse({ description: 'Dispute not found.' })
  @ApiConflictResponse({ description: '`studio_dispute_not_open`.' })
  uphold(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) disputeId: string,
    @Body() body: DecideStudioDisputeDto,
  ): Promise<StudioAdminDispute> {
    return this.disputes.uphold(user.userId, disputeId, body.reply);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a dispute: the release stays down, with a reply.',
  })
  @ApiOkResponse({ description: '`StudioAdminDispute`.' })
  @ApiNotFoundResponse({ description: 'Dispute not found.' })
  @ApiConflictResponse({
    description:
      '`studio_dispute_not_open`, or `studio_release_not_taken_down` when the release is live again.',
  })
  reject(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) disputeId: string,
    @Body() body: DecideStudioDisputeDto,
  ): Promise<StudioAdminDispute> {
    return this.disputes.reject(user.userId, disputeId, body.reply);
  }
}
