import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { NotRestrictedGuard } from '../auth/guards/not-restricted.guard';
import { UpdatePersonaPostDto } from './dto/update-persona-post.dto';
import { PersonaPost } from './persona-post-response';
import { SubprofilePostsService } from './subprofile-posts.service';

// Studio v3: edit or delete one persona post. A post the caller cannot edit
// answers the same 404 as a missing one.
@ApiTags('Subprofiles')
@ApiCookieAuth()
@UseGuards(ActiveMemberGuard)
@Controller('subprofile-posts')
export class PersonaPostEditsController {
  constructor(private readonly posts: SubprofilePostsService) {}

  // Named `update` on purpose: `PERSONA_SCOPED_KEY_HANDLERS` lists
  // `PersonaPostEditsController.update`, so the stored photo key may ride
  // back in the body.
  @Patch(':postId')
  @UseGuards(NotRestrictedGuard)
  @ApiOperation({ summary: 'Edit an update. Edits never alert.' })
  @ApiOkResponse({ description: '`PersonaPost`.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours to edit.' })
  @ApiUnprocessableEntityResponse({
    description: '`persona_post_image_not_allowed`.',
  })
  update(
    @CurrentUser() user: CurrentUserData,
    @Param('postId', ParseUUIDPipe) postId: string,
    @Body() body: UpdatePersonaPostDto,
  ): Promise<PersonaPost> {
    return this.posts.updatePost(user.userId, postId, body);
  }

  @Delete(':postId')
  @UseGuards(NotRestrictedGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an update and its photo.' })
  @ApiNoContentResponse({ description: 'Deleted.' })
  @ApiNotFoundResponse({ description: 'Missing, or not yours to delete.' })
  remove(
    @CurrentUser() user: CurrentUserData,
    @Param('postId', ParseUUIDPipe) postId: string,
  ): Promise<void> {
    return this.posts.deletePost(user.userId, postId);
  }
}
