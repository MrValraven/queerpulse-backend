import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { BrowseFlatmateProfilesQuery } from './dto/browse-flatmate-profiles.query';
import { FlatmateDirectoryService } from './flatmate-directory.service';

/** Member-only flatmate board browse + detail, on its own top-level
 * `/flatmate-directory` path (avoids the `:slug` route-shadow hazard). */
@Feature('flatmateProfiles')
@UseGuards(ActiveMemberGuard)
@Controller('flatmate-directory')
export class FlatmateDirectoryController {
  constructor(private readonly service: FlatmateDirectoryService) {}

  @Get()
  browse(
    @CurrentUser() user: CurrentUserData,
    @Query() query: BrowseFlatmateProfilesQuery,
  ) {
    return this.service.browse(user.userId, query);
  }

  @Get(':slug')
  detail(
    @CurrentUser() user: CurrentUserData,
    @Param('slug') slug: string,
  ) {
    return this.service.detail(user.userId, slug);
  }
}
