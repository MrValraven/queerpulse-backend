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
import { BulkReviewJoinRequestsDto } from './dto/bulk-review-join-requests.dto';
import { ListJoinRequestsQuery } from './dto/list-join-requests.query';
import { ReviewJoinRequestDto } from './dto/review-join-request.dto';
import { SampleJoinRequestsQuery } from './dto/sample-join-requests.query';
import { JoinRequestView } from './join-request-response';
import { JoinRequestsService } from './join-requests.service';
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

/**
 * The moderator/admin review queue for public invite requests.
 *
 * Split out of `JoinRequestsController`, which also exposes the
 * UNAUTHENTICATED `POST /join-requests` a stranger uses to ask for an invite.
 * These four routes each carried their own `@UseGuards(...) @Roles(...)` pair
 * inside that same class, so the guarding was one forgotten decorator away
 * from publishing a privileged route to the world. Guarding at CLASS level (the
 * `AdminInvitesController` / `AdminVerificationController` shape) makes the
 * default for anything added here "staff only" instead of "public".
 *
 * TWO PATHS on purpose. `admin/join-requests` is the canonical one and matches
 * every other admin controller; `join-requests` is the legacy path the SPA
 * still calls. Both are served so this split needed no lockstep frontend
 * release. Once the SPA reads the admin paths, drop `'join-requests'` from the
 * array below and the public controller keeps the bare prefix to itself.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Invite requests')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Authentication is required.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller(['admin/join-requests', 'join-requests'])
export class AdminJoinRequestsController {
  constructor(private readonly joinRequestsService: JoinRequestsService) {}

  @Get()
  @ApiOperation({ summary: 'List invite requests for the review queue' })
  @ApiOkResponse({ description: 'The invite request queue.' })
  list(@Query() query: ListJoinRequestsQuery): Promise<JoinRequestView[]> {
    return this.joinRequestsService.list(query.status, {
      source: query.source,
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
    });
  }

  @Post('bulk')
  @ApiOperation({
    summary: 'Approve, decline, or waitlist multiple invite requests',
  })
  @ApiOkResponse({ description: 'Per-item bulk review result.' })
  bulk(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: BulkReviewJoinRequestsDto,
  ): Promise<{
    succeeded: string[];
    failed: { id: string; reason: string }[];
  }> {
    return this.joinRequestsService.bulkReview(
      dto.ids,
      user.userId,
      dto.status,
      dto.declineReason,
    );
  }

  @Get('sample')
  @ApiOperation({
    summary: 'A random sample of past decisions, for peer quality review',
  })
  @ApiOkResponse({ description: 'Sampled past invite-request decisions.' })
  sample(@Query() query: SampleJoinRequestsQuery): Promise<JoinRequestView[]> {
    return this.joinRequestsService.sample(query.n ?? 10);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Approve or decline an invite request' })
  @ApiOkResponse({ description: 'The updated invite request.' })
  @ApiNotFoundResponse({ description: 'The invite request does not exist.' })
  @ApiConflictResponse({
    description: 'The invite request has already been reviewed.',
  })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
    @Body() dto: ReviewJoinRequestDto,
  ): Promise<JoinRequestView> {
    return this.joinRequestsService.review(
      id,
      user.userId,
      dto.status,
      dto.declineReason,
    );
  }
}
