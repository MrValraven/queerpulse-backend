import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { CinemaReconciliationService } from './cinema-reconciliation.service';
import { CinemaService } from './cinema.service';
import { CreateTitleDto } from './dto/create-title.dto';
import { UpdateTitleDto } from './dto/update-title.dto';

// ActiveMemberGuard runs first (a suspended moderator is locked out), then
// RolesGuard checks moderator/admin. These routes trigger irreversible
// Mux-side asset deletion, so both gates are required — not roles alone.
@Controller('cinema/titles')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminTitlesController {
  constructor(
    private readonly cinema: CinemaService,
    private readonly reconciliation: CinemaReconciliationService,
  ) {}

  @Post()
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateTitleDto) {
    return this.cinema.createTitle(user, dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTitleDto) {
    return this.cinema.updateTitle(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.cinema.deleteTitle(id);
  }

  // Mints a one-time Mux direct-upload URL; the browser PUTs the source file
  // straight to Mux — video bytes never pass through this backend.
  @Post(':id/upload')
  requestUpload(@Param('id', ParseUUIDPipe) id: string) {
    return this.cinema.requestUpload(id);
  }

  // On-demand reconciliation against the Mux API (missed-webhook recovery).
  @Post(':id/refresh')
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.refreshTitle(id);
  }
}
