import {
  Controller,
  Delete,
  Get,
  HttpCode,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { UserRole } from '../users/entities/user.entity';
import { AdminMediaService } from './admin-media.service';
import { AdminMediaListQueryDto } from './dto/admin-media-list-query.dto';
import { AdminMediaHeadQueryDto } from './dto/admin-media-head-query.dto';
import { AdminMediaDeleteQueryDto } from './dto/admin-media-delete-query.dto';

/**
 * Read-only admin media console (security tooling): enumerate raw bucket
 * objects and inspect a single object's real content type. Deliberately NOT
 * `@LockdownExempt()` — nothing here can lift a lockdown.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Media')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires the admin role.' })
@Controller('admin/media')
export class AdminMediaController {
  constructor(private readonly adminMedia: AdminMediaService) {}

  @ApiOperation({ summary: 'List raw uploaded objects in the storage bucket.' })
  @ApiOkResponse({ description: 'One page of stored objects.' })
  @Get()
  list(@Query() query: AdminMediaListQueryDto) {
    return this.adminMedia.list({
      prefix: query.prefix,
      continuationToken: query.continuationToken,
      limit: query.limit,
    });
  }

  @ApiOperation({
    summary: "Inspect a single object's real stored content type.",
  })
  @ApiOkResponse({ description: 'The object head metadata.' })
  @Get('head')
  head(@Query() query: AdminMediaHeadQueryDto) {
    return this.adminMedia.head(query.key);
  }

  @ApiOperation({
    summary: 'Permanently delete one stored object from the bucket.',
  })
  @ApiNoContentResponse({ description: 'The object was deleted.' })
  @Delete()
  @HttpCode(204)
  delete(@Query() query: AdminMediaDeleteQueryDto): Promise<void> {
    return this.adminMedia.delete(query.key);
  }
}
