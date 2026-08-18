import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { Feature } from '../common/feature.decorator';
import { CreateWriterApplicationDto } from './dto/create-writer-application.dto';
import { WriterApplicationsService } from './writer-applications.service';

@Feature('magazine')
@ApiTags('Magazine — Writer applications')
@ApiCookieAuth()
@Controller('magazine/writer-applications')
@UseGuards(ActiveMemberGuard)
export class WriterApplicationsController {
  constructor(private readonly writerApplications: WriterApplicationsService) {}

  @Post()
  @ApiOperation({ summary: 'Apply to become a magazine writer' })
  @ApiCreatedResponse({ description: 'The created application.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  create(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreateWriterApplicationDto,
  ) {
    return this.writerApplications.create(user.userId, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: "The current member's latest writer application" })
  @ApiOkResponse({ description: 'The latest application, or null.' })
  @ApiUnauthorizedResponse({
    description: 'Not an authenticated active member.',
  })
  getMine(@CurrentUser() user: CurrentUserData) {
    return this.writerApplications.getMine(user.userId);
  }
}
