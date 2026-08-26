import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiConflictResponse,
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
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { AdminGlossaryService } from './admin-glossary.service';
import { CreateGlossaryTermDto } from './dto/create-glossary-term.dto';
import { ListGlossaryQuery } from './dto/list-glossary.query';
import { ReviewResourceDto } from './dto/review-resource.dto';
import { UpdateGlossaryTermDto } from './dto/update-glossary-term.dto';

/**
 * Admin CRUD over the glossary (CON-08). Split from
 * `AdminResourcesController` for the same reason `GlossaryController` is
 * split from `ResourcesController`: a distinct resource under the same
 * feature. Staff-guarded, with deletion narrowed to Admin — a term readers
 * link to should not vanish on one moderator's judgement.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Glossary')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a staff role.' })
@Controller('admin/glossary')
export class AdminGlossaryController {
  constructor(private readonly adminGlossary: AdminGlossaryService) {}

  @Get()
  @ApiOperation({ summary: 'List every glossary term, stalest first' })
  @ApiOkResponse({ description: 'Every term, never-reviewed first.' })
  list(@Query() query: ListGlossaryQuery) {
    return this.adminGlossary.list(query.category);
  }

  @Post()
  @ApiOperation({ summary: 'Create a glossary term' })
  @ApiCreatedResponse({ description: 'The created term.' })
  @ApiConflictResponse({ description: 'That slug is already taken.' })
  create(
    @Body() dto: CreateGlossaryTermDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminGlossary.create(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a glossary term' })
  @ApiOkResponse({ description: 'The updated term.' })
  @ApiNotFoundResponse({ description: 'No term with that id.' })
  @ApiConflictResponse({ description: 'That slug is already taken.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateGlossaryTermDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminGlossary.update(id, dto, user.userId);
  }

  @Post(':id/review')
  @ApiOperation({ summary: 'Stamp an editorial review on a term' })
  @ApiOkResponse({ description: 'The term with its review dates updated.' })
  @ApiNotFoundResponse({ description: 'No term with that id.' })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewResourceDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminGlossary.review(id, dto, user.userId);
  }

  @Delete(':id')
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a glossary term' })
  @ApiNoContentResponse({ description: 'The term was deleted.' })
  @ApiNotFoundResponse({ description: 'No term with that id.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminGlossary.remove(id);
  }
}
