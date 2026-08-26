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
  ApiCookieAuth,
  ApiForbiddenResponse,
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
import { QueueAssignmentDto } from '../common/queue-assignment.dto';
import { UserRole } from '../users/entities/user.entity';
import {
  BulkDecideVerificationRequestsDto,
  BulkDecideVerificationRequestsResultDTO,
} from './dto/bulk-decide-verification-requests.dto';
import { DecideVerificationRequestDto } from './dto/decide-verification-request.dto';
import { ListAdminVerificationsQuery } from './dto/list-admin-verifications.query';
import { ListVerificationRequestsQuery } from './dto/list-verification-requests.query';
import { OverrideVerificationDto } from './dto/override-verification.dto';
import {
  AdminVerificationDTO,
  AdminVerificationListDTO,
  AdminVerificationRequestDetailDTO,
  AdminVerificationRequestDTO,
  AdminVerificationRequestListDTO,
  toAdminVerificationDTO,
  toAdminVerificationRequestDTO,
  VerificationEventDTO,
} from './verification-response';
import { VerificationService } from './verification.service';

/**
 * Admin review of the manual/stub verification path. Lets a moderator or admin
 * grant or revoke a member's level after a human review (the stub identity
 * path), recorded as a `manual_review`/`admin` provenance so a badge never
 * over-claims. No document data is ever surfaced here — none is stored.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Verification')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the moderator or admin role.' })
@Controller('admin/verifications')
export class AdminVerificationController {
  constructor(private readonly service: VerificationService) {}

  @Get()
  @ApiOperation({
    summary: 'List, search, and sort member verification records for review',
  })
  @ApiOkResponse({
    description: 'A page of verification rows plus per-level tab counts.',
  })
  list(
    @Query() query: ListAdminVerificationsQuery,
  ): Promise<AdminVerificationListDTO> {
    return this.service.listForAdmin({
      level: query.level,
      query: query.q,
      sort: query.sort,
      cursor: query.cursor,
    });
  }

  // The three `requests` routes are declared BEFORE the `:userId` routes
  // below (both literal-before-parameterized, defensive NestJS routing
  // convention, and to keep the two families visually grouped) even though
  // their path depths don't actually collide today.
  @Get('requests')
  @ApiOperation({
    summary:
      'List, search, filter, and sort member verification requests for review',
  })
  @ApiOkResponse({
    description: 'A page of request rows plus per-status tab counts.',
  })
  listRequests(
    @CurrentUser() user: CurrentUserData,
    @Query() query: ListVerificationRequestsQuery,
  ): Promise<AdminVerificationRequestListDTO> {
    return this.service.listRequestsForAdmin({
      status: query.status,
      type: query.type,
      query: query.q,
      sort: query.sort,
      cursor: query.cursor,
      // `me` is resolved here, from the session, so the wire never carries a
      // reviewer's id and one reviewer cannot ask what another is holding.
      assignedTo:
        query.assignedTo === 'me'
          ? user.userId
          : (query.assignedTo ?? undefined),
    });
  }

  // Declared before `requests/:id` below, same literal-before-parameterized
  // convention as the rest of this controller — POST/GET are different
  // methods so it wouldn't actually collide, but it keeps the `requests`
  // family visually grouped by specificity.
  @Post('requests/bulk')
  @ApiOperation({
    summary:
      'Decide many verification requests in one call (bulk approve/reject/in-review)',
  })
  @ApiOkResponse({
    description: 'Which request ids succeeded and which failed, per id.',
  })
  bulkDecide(
    @Body() dto: BulkDecideVerificationRequestsDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<BulkDecideVerificationRequestsResultDTO> {
    return this.service.bulkDecide(
      dto.ids,
      user.userId,
      dto.action,
      dto.reason,
    );
  }

  /**
   * Claim or release a verification request (OPS-04).
   *
   * The same route shape, body and semantics as
   * `PATCH /mod/reports/:id/assignment`: self-assign only, 409 when another
   * reviewer holds it, and release only what you hold (admins override both,
   * so the queue cannot deadlock on someone who left). Declared before
   * `PATCH requests/:id` for the literal-before-parameterized convention the
   * rest of this controller follows, and inherits the class-level
   * `@Roles(Moderator, Admin)` gate the queue already carries.
   *
   * Claiming is not `in_review`. That status is a decision the member sees;
   * this is bookkeeping between staff.
   */
  @Patch('requests/:id/assignment')
  @ApiOperation({ summary: 'Claim or release a verification request' })
  @ApiOkResponse({ description: 'The updated request, hand-mapped.' })
  setRequestAssignment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueAssignmentDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminVerificationRequestDTO> {
    return this.service.setRequestAssignment(
      id,
      user.userId,
      user.role,
      dto.assign,
    );
  }

  @Get('requests/:id')
  @ApiOperation({
    summary:
      'A verification request in full — context, signals, and audit history',
  })
  @ApiOkResponse({ description: 'The request detail.' })
  requestDetail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminVerificationRequestDetailDTO> {
    return this.service.requestDetailDTO(id);
  }

  @Patch('requests/:id')
  @ApiOperation({
    summary:
      'Decide a verification request — mark in-review, approve, or reject',
  })
  @ApiOkResponse({ description: 'The decided request, hand-mapped.' })
  async decideRequest(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideVerificationRequestDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminVerificationRequestDTO> {
    const saved = await this.service.decideRequest(
      id,
      user.userId,
      dto.action,
      dto.reason,
    );
    const member = await this.service.getMemberRef(saved.userId);
    return toAdminVerificationRequestDTO(saved, member);
  }

  @Get(':userId/history')
  @ApiOperation({
    summary: "A member's verification audit history, newest first",
  })
  @ApiOkResponse({ description: "The member's audit trail." })
  history(
    @Param('userId', ParseUUIDPipe) userId: string,
  ): Promise<VerificationEventDTO[]> {
    return this.service.listHistoryDTO(userId);
  }

  @Patch(':userId')
  @ApiOperation({
    summary: "Override a member's verification level (manual review)",
  })
  @ApiOkResponse({
    description: 'The updated, hand-mapped verification record.',
  })
  async override(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: OverrideVerificationDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AdminVerificationDTO> {
    // `override` returns the raw entity (it always has — see its own doc);
    // this hand-maps it through the same `toAdminVerificationDTO` mapper the
    // list uses, re-loading the member ref since the entity alone doesn't
    // carry it. Fixes the raw-entity serialization the prior placeholder
    // call-site returned directly.
    const saved = await this.service.override(
      userId,
      dto.level,
      user.userId,
      dto.note,
    );
    const member = await this.service.getMemberRef(userId);
    return toAdminVerificationDTO(saved, member);
  }
}
