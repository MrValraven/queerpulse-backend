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
import { Throttle, seconds } from '@nestjs/throttler';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateInquiryDto } from './dto/create-inquiry.dto';
import { ListInquiriesQuery } from './dto/list-inquiries.query';
import { UpdateInquiryStatusDto } from './dto/update-inquiry-status.dto';
import { InquiriesService } from './inquiries.service';

/**
 * Public marketing-form intake. `POST /inquiries` is `@Public()` — the Contact
 * and For-Organisations forms are on unauthenticated marketing pages — and
 * rate-limited so the open endpoint can't be flooded. The admin `GET` and
 * `PATCH` are guarded identically (Admin only) for triaging what came in —
 * QueerPulse sends no email, so this list IS the reply path, and an inquiry
 * nobody reads is a permanently dropped relationship.
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
    description:
      'A page of inquiries, newest first, optionally filtered by kind and ' +
      'status. Carries `unhandledCount` for the console badge, so the badge ' +
      'costs no second request.',
  })
  @ApiOkResponse({ description: 'A page of inquiries, newest first.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  @ApiCookieAuth('access_token')
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Get()
  list(@Query() query: ListInquiriesQuery) {
    return this.inquiriesService.list(query);
  }

  @ApiOperation({
    summary: 'Move an inquiry through triage (admin only).',
    description:
      'Flipping to `handled` stamps the acting admin and the time; flipping ' +
      'back to `new` clears both, because a re-opened inquiry has no handler.',
  })
  @ApiOkResponse({ description: 'The updated inquiry.' })
  @ApiBadRequestResponse({ description: 'An invalid target status or id.' })
  @ApiUnauthorizedResponse({ description: 'Not authenticated.' })
  @ApiForbiddenResponse({ description: 'Requires the admin role.' })
  @ApiNotFoundResponse({ description: 'No inquiry with that id.' })
  @ApiCookieAuth('access_token')
  // Guarded exactly like the `GET` above: whoever can read this inbox is
  // whoever can work it.
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  @Patch(':id')
  updateStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: UpdateInquiryStatusDto,
    @CurrentUser() admin: CurrentUserData,
  ) {
    return this.inquiriesService.updateStatus(id, body.status, admin.userId);
  }
}
