import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { Paginated } from '../common/pagination';
import { UserRole } from '../users/entities/user.entity';
import { ListChangesQuery } from './dto/list-changes.query';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import {
  PlatformSettingChangeDTO,
  PlatformSettingsDTO,
  toPlatformSettingsDTO,
} from './platform-settings-response';
import { PlatformSettingsService } from './platform-settings.service';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

const DEFAULT_CHANGES_LIMIT = 50;

/**
 * Admin-only, and deliberately NOT `@Roles(Moderator, Admin)` like the `/mod`
 * surface: these are the highest-blast-radius controls in the product, and the
 * lockdown switch decides whether moderators can reach anything at all.
 *
 * `@LockdownExempt()` is load-bearing — without it, enabling lockdown would
 * lock the admin out of the only endpoint that can disable it.
 *
 * Every handler answers with a shape from `platform-settings-response.ts`, not
 * with its TypeORM row. There is no global serializer in this app, so a
 * pass-through here would ship whatever columns the entity happens to carry at
 * deploy time, on the most sensitive table in the product. See that file for
 * which fields are in, which are out, and why.
 */
@LockdownExempt()
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Platform Settings')
@ApiCookieAuth()
@Controller('admin/platform-settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Get the platform settings' })
  @ApiOkResponse({ description: 'The current platform settings.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  async get(): Promise<PlatformSettingsDTO> {
    return toPlatformSettingsDTO(await this.settings.get());
  }

  @Patch()
  @ApiOperation({ summary: 'Update the platform settings' })
  @ApiOkResponse({ description: 'The updated platform settings.' })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  async update(
    @Body() dto: UpdatePlatformSettingsDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<PlatformSettingsDTO> {
    return toPlatformSettingsDTO(await this.settings.update(dto, user.userId));
  }

  @Get('changes')
  @ApiOperation({ summary: 'List the platform settings change history' })
  @ApiOkResponse({
    description:
      'The audit history, newest first, as a `Paginated` envelope carrying the full row count.',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication is required.' })
  @ApiForbiddenResponse({ description: 'Requires an admin role.' })
  listChanges(
    @Query() query: ListChangesQuery,
  ): Promise<Paginated<PlatformSettingChangeDTO>> {
    return this.settings.listChanges(
      query.limit ?? DEFAULT_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }
}
