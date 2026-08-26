import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Public } from '../auth/decorators/public.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import { CreateOrgTierDto } from './dto/create-org-tier.dto';
import { UpdateOrgTierDto } from './dto/update-org-tier.dto';
import { OrgTiersService } from './org-tiers.service';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  PUBLIC_READ_CACHE,
  PUBLIC_READ_CDN_CACHE,
} from '../common/public-read-cache';

// Public marketing content — the For Organisations page is reachable logged-out,
// so the tier list opts out of auth (mirrors PlatformStatusController /
// HealthController's class-level @Public()).
@Public()
@ApiTags('Org Tiers')
@Controller('org-tiers')
export class OrgTiersController {
  constructor(private readonly orgTiersService: OrgTiersService) {}

  // Same published-tiers response for every anonymous visitor — see
  // AUDIT-2026-07-30.md §I "No CDN cache headers on public GETs" /
  // `caching-and-cost.md`.
  @Get()
  @Header('Cache-Control', PUBLIC_READ_CACHE)
  @Header('CDN-Cache-Control', PUBLIC_READ_CDN_CACHE)
  @ApiOperation({ summary: 'List published organisation tiers' })
  @ApiOkResponse({ description: 'Published tiers in display order.' })
  list() {
    return this.orgTiersService.listPublished();
  }
}

@ApiTags('Admin — Org Tiers')
@ApiCookieAuth()
@Controller('admin/org-tiers')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('partnerships')
export class AdminOrgTiersController {
  constructor(private readonly orgTiersService: OrgTiersService) {}

  @Get()
  @ApiOperation({ summary: 'List all organisation tiers (published or not)' })
  @ApiOkResponse({ description: 'Every tier in display order.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  list() {
    return this.orgTiersService.listAll();
  }

  @Post()
  @ApiOperation({ summary: 'Create an organisation tier' })
  @ApiCreatedResponse({ description: 'The created tier.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  @ApiConflictResponse({
    description: 'Could not allocate a unique tier slug.',
  })
  create(@Body() dto: CreateOrgTierDto) {
    return this.orgTiersService.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update an organisation tier' })
  @ApiOkResponse({ description: 'The updated tier.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  @ApiNotFoundResponse({ description: 'The tier does not exist.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrgTierDto,
  ) {
    return this.orgTiersService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an organisation tier' })
  @ApiNoContentResponse({ description: 'The tier was deleted.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({
    description: 'Requires the admin role, or the `partnerships` staff role.',
  })
  @ApiNotFoundResponse({ description: 'The tier does not exist.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.orgTiersService.remove(id);
  }
}
