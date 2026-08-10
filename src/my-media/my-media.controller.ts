import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MyMediaService } from './my-media.service';

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
    const items = await this.myMedia.listMine(user.userId);
    return { items };
  }
}
