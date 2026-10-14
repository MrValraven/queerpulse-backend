import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
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
import { RemovePersonaPostDto } from './dto/remove-persona-post.dto';
import {
  AdminPersonaPost,
  SubprofilePostModerationService,
} from './subprofile-post-moderation.service';

// The reports queue's persona post actions (Studio v3).
@ApiTags('Admin: Persona posts')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({ description: 'Requires a moderator or admin role.' })
@Controller('admin/persona-posts')
@UseGuards(ActiveMemberGuard, RolesGuard)
@Roles(UserRole.Moderator, UserRole.Admin)
export class AdminPersonaPostsController {
  constructor(private readonly moderation: SubprofilePostModerationService) {}

  @Get(':postId')
  @ApiOperation({ summary: 'A reported post, its photo and its persona.' })
  @ApiOkResponse({ description: '`AdminPersonaPost`.' })
  @ApiNotFoundResponse({ description: 'Post not found.' })
  getPost(
    @Param('postId', ParseUUIDPipe) postId: string,
  ): Promise<AdminPersonaPost> {
    return this.moderation.getForStaff(postId);
  }

  @Post(':postId/remove')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a post, with a reason for the audit trail.',
  })
  @ApiNoContentResponse({ description: 'Removed.' })
  @ApiNotFoundResponse({
    description:
      'Post not found, or `Report not found` when `reportId` names no `persona_post` report about this post.',
  })
  removePost(
    @CurrentUser() user: CurrentUserData,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: RemovePersonaPostDto,
  ): Promise<void> {
    return this.moderation.removePost(
      user.userId,
      postId,
      body.reason,
      body.reportId,
    );
  }
}
