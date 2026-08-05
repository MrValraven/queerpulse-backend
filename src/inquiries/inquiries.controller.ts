import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { InquiriesService } from './inquiries.service';

/**
 * Public marketing-form intake. `POST /inquiries` is `@Public()` — the Contact
 * and For-Organisations forms are on unauthenticated marketing pages — and
 * rate-limited so the open endpoint can't be flooded. The admin `GET` is guarded
 * (Admin only) for triaging what came in.
 */
@ApiTags('Inquiries')
@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @ApiOperation({
    summary:
      'Submit a contact or partnership inquiry (public marketing forms).',
  })
  @ApiCreatedResponse({
    description: 'Stored; returns the acknowledgement id.',
  })
  @ApiTooManyRequestsResponse({ description: 'Rate limit exceeded.' })
  @Public()
  @Throttle({ default: { limit: 5, ttl: seconds(60) } })
  @Post()
  create(@Body() body: CreateInquiryDto) {
    return this.inquiriesService.create(body);
  }

  @ApiOperation({
    summary: 'List submitted inquiries for triage (admin only).',
  })
  @ApiOkResponse({ description: 'The inquiries, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  @ApiCookieAuth('access_token')
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Get()
  list() {
    return this.inquiriesService.list();
  }
}
