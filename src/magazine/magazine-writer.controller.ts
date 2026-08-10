import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
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
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { StaffRolesGuard } from '../auth/guards/staff-roles.guard';
import { Feature } from '../common/feature.decorator';
import { CreatePieceMessageDto } from './dto/create-piece-message.dto';
import { SubmitPitchDto } from './dto/submit-pitch.dto';
import { UpdateBylineDto } from './dto/update-byline.dto';
import { MagazinePieceService } from './magazine-piece.service';

// ActiveMemberGuard runs first (a suspended writer is locked out), then
// StaffRolesGuard requires the `magazine_writer` staff role (admins are a
// superset). Route prefix is `magazine/writer`, distinct from
// `magazine/admin/*` on AdminMagazinePiecesController and the public
// `magazine/*` GET routes on MagazineController.
//
// SECURITY: every route below passes `user.userId` (never a client-supplied
// id) as the writer id into `MagazinePieceService`, which further asserts
// ownership server-side (ForbiddenException on a piece that isn't the
// caller's). A writer must never be able to read or mutate another
// contributor's assignments, pitches, or payments.
@Feature('magazine')
@ApiTags('Magazine — Writer Workspace')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description: 'Magazine writer staff role or admin role required.',
})
@Controller('magazine/writer')
@UseGuards(ActiveMemberGuard, StaffRolesGuard)
@StaffRoles('magazine_writer')
export class MagazineWriterController {
  constructor(private readonly magazinePieces: MagazinePieceService) {}

  @Get('assignments')
  @ApiOperation({
    summary: "List the authenticated writer's own assignments.",
  })
  @ApiOkResponse({ description: "The writer's pieces, as assignments." })
  listMyAssignments(@CurrentUser() user: CurrentUserData) {
    return this.magazinePieces.listMyAssignments(user.userId);
  }

  @Get('pitches')
  @ApiOperation({ summary: "List the authenticated writer's own pitches." })
  @ApiOkResponse({ description: "The writer's submitted pitches." })
  listMyPitches(@CurrentUser() user: CurrentUserData) {
    return this.magazinePieces.listMyPitches(user.userId);
  }

  @Post('pitches')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a new pitch as the authenticated writer.' })
  @ApiCreatedResponse({ description: 'The created pitch.' })
  @ApiBadRequestResponse({ description: 'The pitch payload is invalid.' })
  submitPitch(
    @Body() dto: SubmitPitchDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.submitPitch(user.userId, dto);
  }

  @Get('payments')
  @ApiOperation({
    summary: "List payments for the authenticated writer's own pieces.",
  })
  @ApiOkResponse({ description: "The writer's payments." })
  listMyPayments(@CurrentUser() user: CurrentUserData) {
    return this.magazinePieces.listMyPayments(user.userId);
  }

  @Patch('pieces/:id/byline')
  @ApiOperation({
    summary: "Update the byline on the authenticated writer's own piece.",
  })
  @ApiOkResponse({ description: 'The updated assignment.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  @ApiForbiddenResponse({
    description:
      "The piece isn't this writer's, or its byline is already locked.",
  })
  updateMyByline(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBylineDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.updateMyByline(user.userId, id, dto);
  }

  @Post('pieces/:id/file')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "File a draft for the authenticated writer's own piece.",
  })
  @ApiOkResponse({ description: 'The updated assignment.' })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  @ApiForbiddenResponse({ description: "The piece isn't this writer's." })
  fileDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.fileDraft(user.userId, id);
  }

  @Get('pieces/:id/messages')
  @ApiOperation({
    summary:
      "List the editor↔writer message thread for the authenticated writer's own piece.",
  })
  @ApiOkResponse({
    description: 'The thread, oldest first, author names resolved.',
  })
  @ApiBadRequestResponse({ description: 'Malformed piece id.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  @ApiForbiddenResponse({ description: "The piece isn't this writer's." })
  listPieceMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.listPieceMessages(id, user.userId, false);
  }

  @Post('pieces/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      "Post to the editor↔writer message thread for the authenticated writer's own piece.",
  })
  @ApiCreatedResponse({ description: 'The created message.' })
  @ApiBadRequestResponse({ description: 'Malformed id or invalid payload.' })
  @ApiNotFoundResponse({ description: 'No piece exists for this id.' })
  @ApiForbiddenResponse({ description: "The piece isn't this writer's." })
  postPieceMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePieceMessageDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.magazinePieces.postPieceMessage(id, user.userId, false, dto);
  }
}
