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
import { Feature } from '../common/feature.decorator';
import { UserRole } from '../users/entities/user.entity';
import { CinemaReconciliationService } from './cinema-reconciliation.service';
import { CinemaService } from './cinema.service';
import { CreateTitleDto } from './dto/create-title.dto';
import { UpdateTitleDto } from './dto/update-title.dto';
import {
  ApiBadRequestResponse,
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

// ActiveMemberGuard runs first (a suspended moderator is locked out), then
// RolesGuard checks moderator/admin. These routes trigger irreversible
// Mux-side asset deletion, so both gates are required — not roles alone.
@Feature('cinema')
@ApiTags('Admin — Cinema')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Moderator or admin role required.' })
@Controller('cinema/titles')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminTitlesController {
  constructor(
    private readonly cinema: CinemaService,
    private readonly reconciliation: CinemaReconciliationService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Create a draft cinema title.' })
  @ApiCreatedResponse({ description: 'The created draft title.' })
  @ApiBadRequestResponse({ description: 'The title payload is invalid.' })
  create(@CurrentUser() user: CurrentUserData, @Body() dto: CreateTitleDto) {
    return this.cinema.createTitle(user, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a cinema title, including publish state.' })
  @ApiOkResponse({ description: 'The updated title.' })
  @ApiBadRequestResponse({
    description:
      'Malformed id, invalid payload, or the title is not ready to publish.',
  })
  @ApiNotFoundResponse({ description: 'No title exists for this id.' })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTitleDto,
  ) {
    return this.cinema.updateTitle(user.userId, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a cinema title and its Mux assets (best-effort).',
  })
  @ApiNoContentResponse({ description: 'The title was deleted.' })
  @ApiBadRequestResponse({ description: 'Malformed title id.' })
  @ApiNotFoundResponse({ description: 'No title exists for this id.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.cinema.deleteTitle(id);
  }

  // Mints a one-time Mux direct-upload URL; the browser PUTs the source file
  // straight to Mux — video bytes never pass through this backend.
  @Post(':id/upload')
  @ApiOperation({
    summary: 'Mint a one-time Mux direct-upload URL for a title.',
  })
  @ApiCreatedResponse({
    description: 'A one-time Mux upload id and upload URL.',
  })
  @ApiBadRequestResponse({ description: 'Malformed title id.' })
  @ApiNotFoundResponse({ description: 'No title exists for this id.' })
  @ApiConflictResponse({ description: 'An upload is already processing.' })
  requestUpload(@Param('id', ParseUUIDPipe) id: string) {
    return this.cinema.requestUpload(id);
  }

  // On-demand reconciliation against the Mux API (missed-webhook recovery).
  @Post(':id/refresh')
  @ApiOperation({
    summary: 'Reconcile a title against the Mux API (missed-webhook recovery).',
  })
  @ApiCreatedResponse({ description: 'The title after reconciliation.' })
  @ApiBadRequestResponse({ description: 'Malformed title id.' })
  @ApiNotFoundResponse({ description: 'No title exists for this id.' })
  refresh(@Param('id', ParseUUIDPipe) id: string) {
    return this.reconciliation.refreshTitle(id);
  }
}
