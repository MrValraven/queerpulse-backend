import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCookieAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MyMediaService } from './my-media.service';
import { DeleteMyMediaDto } from './dto/delete-my-media.dto';

@UseGuards(ActiveMemberGuard)
@ApiTags('Account — My uploads')
@ApiCookieAuth('access_token')
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@Controller('me/media')
export class MyMediaController {
  constructor(private readonly myMedia: MyMediaService) {}

  @ApiOperation({ summary: 'List every image the current member uploaded.' })
  @ApiOkResponse({ description: 'The caller-uploaded objects, newest first.' })
  @Get()
  async list(@CurrentUser() user: CurrentUserData) {
    return await this.myMedia.listMine(user.userId);
  }

  @ApiOperation({ summary: 'Delete one image the current member uploaded.' })
  @ApiOkResponse({ description: 'The object was deleted.' })
  @ApiForbiddenResponse({
    description: 'The key is not the caller-owned upload.',
  })
  @ApiConflictResponse({
    description:
      'The upload is still referenced. The body carries `references` — every place it is used — so the caller can detach it there first.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Reference checking is degraded, so the upload could not be proven unused. Deleting is refused rather than risking a live image.',
  })
  @Delete()
  @HttpCode(200)
  async remove(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: DeleteMyMediaDto,
  ) {
    await this.myMedia.deleteMine(user.userId, dto.key);
    return { deleted: true };
  }
}
