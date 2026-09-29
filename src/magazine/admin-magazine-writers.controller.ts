import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { MagazineWriterDirectoryService } from './magazine-writer-directory.service';

// Same guard chain as AdminMagazinePiecesController: ActiveMemberGuard first
// (a suspended moderator is locked out), then StaffRolesGuard requires the
// `magazine_editor` staff role (admins are a superset). Its own controller,
// per the admin-CRUD convention; the route is `magazine/admin/writers`.
@Feature('magazine')
@ApiTags('Admin — Magazine')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine editor staff role or admin role required.',
})
@Controller('magazine/admin')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_editor')
export class AdminMagazineWritersController {
  constructor(
    private readonly writerDirectory: MagazineWriterDirectoryService,
  ) {}

  @Get('writers')
  @ApiOperation({
    summary:
      'List the magazine writer directory: active magazine_writer staff-role holders.',
  })
  @ApiOkResponse({
    description: 'Writers, hand-mapped with no user-account leak.',
  })
  listMagazineWriters() {
    return this.writerDirectory.listMagazineWriters();
  }
}
