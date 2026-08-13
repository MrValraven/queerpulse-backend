import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { OverrideVerificationDto } from './dto/override-verification.dto';
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
    summary: 'List recent member verification records for review',
  })
  @ApiOkResponse({ description: 'The verification rows.' })
  list() {
    return this.service.listForAdmin();
  }

  @Patch(':userId')
  @ApiOperation({
    summary: "Override a member's verification level (manual review)",
  })
  @ApiOkResponse({ description: 'The updated verification record.' })
  override(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: OverrideVerificationDto,
  ) {
    return this.service.override(userId, dto.level);
  }
}
