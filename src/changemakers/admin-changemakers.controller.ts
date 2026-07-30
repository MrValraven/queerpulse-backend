import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { UserRole } from '../users/entities/user.entity';
import { ChangemakersService } from './changemakers.service';
import { CreateChangemakerDto } from './dto/create-changemaker.dto';
import { PublishChangemakerDto } from './dto/publish-changemaker.dto';
import { UpdateChangemakerDto } from './dto/update-changemaker.dto';
import { UpdateDirectoryStatsDto } from './dto/update-directory-stats.dto';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Admin)
@ApiTags('Admin — Changemakers')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Admin role required.' })
@Controller('admin/changemakers')
export class AdminChangemakersController {
  constructor(private readonly changemakers: ChangemakersService) {}

  @Get()
  @ApiOperation({
    summary: 'List all changemaker profiles (drafts included) for admins.',
  })
  @ApiOkResponse({ description: 'Every changemaker profile, draft or published.' })
  list() {
    return this.changemakers.listAdmin();
  }

  // Declared before ':id' so 'stats' is not captured as an id param.
  @Patch('stats')
  @ApiOperation({ summary: 'Update the directory-wide changemaker stats.' })
  @ApiOkResponse({ description: 'The recomputed directory stats.' })
  updateStats(@Body() dto: UpdateDirectoryStatsDto) {
    return this.changemakers.updateStats(dto);
  }

  @Post()
  @ApiOperation({ summary: 'Create a new (draft) changemaker profile.' })
  @ApiCreatedResponse({ description: 'The created draft changemaker profile.' })
  @ApiConflictResponse({
    description: 'Could not allocate a unique changemaker slug.',
  })
  create(@Body() dto: CreateChangemakerDto) {
    return this.changemakers.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a changemaker profile by id.' })
  @ApiOkResponse({ description: 'The updated changemaker profile.' })
  @ApiNotFoundResponse({ description: 'No changemaker exists for this id.' })
  update(@Param('id') id: string, @Body() dto: UpdateChangemakerDto) {
    return this.changemakers.update(id, dto);
  }

  @Patch(':id/publish')
  @ApiOperation({ summary: 'Publish or unpublish a changemaker profile.' })
  @ApiOkResponse({ description: 'The changemaker profile with its new status.' })
  @ApiNotFoundResponse({ description: 'No changemaker exists for this id.' })
  publish(@Param('id') id: string, @Body() body: PublishChangemakerDto) {
    return this.changemakers.setPublished(id, body.published);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a changemaker profile by id.' })
  @ApiOkResponse({ description: 'The changemaker profile was deleted.' })
  @ApiNotFoundResponse({ description: 'No changemaker exists for this id.' })
  remove(@Param('id') id: string) {
    return this.changemakers.remove(id);
  }
}
