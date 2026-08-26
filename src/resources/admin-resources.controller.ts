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
import { AdminResourcesService } from './admin-resources.service';
import { CreateResourceDto } from './dto/create-resource.dto';
import { ListAdminResourcesQuery } from './dto/list-admin-resources.query';
import { ReviewResourceDto } from './dto/review-resource.dto';
import { UpdateResourceDto } from './dto/update-resource.dto';

/**
 * Admin CRUD over the editorial resource guides (CON-08 / CON-09) — the
 * authoring endpoint the `Resource` entity used to say did not exist.
 *
 * `@Roles(Moderator, Admin)` at the class level: these are the highest-stakes
 * pages on the platform (trans healthcare pathways, harm reduction, crisis
 * lines, legal aid), and the editorial team that maintains them is staff, not
 * admins only. There is no Editor role in this codebase, so staff-guarded
 * means exactly this pair. Publish/unpublish is narrowed to Admin: taking a
 * crisis guide off the site, or putting an unreviewed one on it, is a
 * higher bar than editing a paragraph.
 */
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
@ApiTags('Admin — Resource guides')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a staff role.' })
@Controller('admin/resources')
export class AdminResourcesController {
  constructor(private readonly adminResources: AdminResourcesService) {}

  @Get()
  @ApiOperation({
    summary: 'List every guide, published or not, stalest first',
  })
  @ApiOkResponse({
    description:
      'Every guide. Default sort is review-due with never-reviewed first.',
  })
  list(@Query() query: ListAdminResourcesQuery) {
    return this.adminResources.list(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one guide for editing' })
  @ApiOkResponse({ description: 'The guide, prose included.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  getById(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminResources.getById(id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a guide' })
  @ApiCreatedResponse({ description: 'The created guide.' })
  @ApiConflictResponse({ description: 'That slug is already taken.' })
  create(@Body() dto: CreateResourceDto, @CurrentUser() user: CurrentUserData) {
    return this.adminResources.create(dto, user.userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a guide, prose included' })
  @ApiOkResponse({ description: 'The updated guide.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  @ApiConflictResponse({ description: 'That slug is already taken.' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResources.update(id, dto, user.userId);
  }

  @Post(':id/review')
  @ApiOperation({
    summary: 'Stamp an editorial review: read end to end, still accurate',
  })
  @ApiOkResponse({ description: 'The guide with its review dates updated.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  review(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewResourceDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResources.review(id, dto, user.userId);
  }

  @Post(':id/publish')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Publish a guide to the public library' })
  @ApiOkResponse({ description: 'The published guide.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResources.setPublished(id, true, user.userId);
  }

  @Post(':id/unpublish')
  @Roles(UserRole.Admin)
  @ApiOperation({ summary: 'Take a guide off the public library' })
  @ApiOkResponse({ description: 'The unpublished guide.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  unpublish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.adminResources.setPublished(id, false, user.userId);
  }

  @Delete(':id')
  @Roles(UserRole.Admin)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a guide' })
  @ApiNoContentResponse({ description: 'The guide was deleted.' })
  @ApiNotFoundResponse({ description: 'No guide with that id.' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminResources.remove(id);
  }
}
