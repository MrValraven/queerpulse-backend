import { Body, Controller, Get, Patch, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { LockdownExempt } from '../common/lockdown-exempt.decorator';
import { UserRole } from '../users/entities/user.entity';
import { ListChangesQuery } from './dto/list-changes.query';
import { UpdatePlatformSettingsDto } from './dto/update-platform-settings.dto';
import { PlatformSettingsService } from './platform-settings.service';

const DEFAULT_CHANGES_LIMIT = 50;

/**
 * Admin-only, and deliberately NOT `@Roles(Moderator, Admin)` like the `/mod`
 * surface: these are the highest-blast-radius controls in the product, and the
 * lockdown switch decides whether moderators can reach anything at all.
 *
 * `@LockdownExempt()` is load-bearing — without it, enabling lockdown would
 * lock the admin out of the only endpoint that can disable it.
 */
@LockdownExempt()
@UseGuards(RolesGuard)
@Roles(UserRole.Admin)
@Controller('admin/platform-settings')
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  @Patch()
  update(
    @Body() dto: UpdatePlatformSettingsDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.settings.update(dto, user.userId);
  }

  @Get('changes')
  listChanges(@Query() query: ListChangesQuery) {
    return this.settings.listChanges(
      query.limit ?? DEFAULT_CHANGES_LIMIT,
      query.offset ?? 0,
    );
  }
}
