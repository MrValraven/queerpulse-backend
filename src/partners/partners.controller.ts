import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
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
import { CreatePartnerApplicationDto } from './dto/create-partner-application.dto';
import { ListPartnersQuery } from './dto/list-partners.query';
import { TriagePartnerApplicationDto } from './dto/triage-partner-application.dto';
import { PartnersService } from './partners.service';

// Public directory: approved partners only. Any active member can browse it,
// but there's no ownership/authorship concept here (unlike companies/jobs),
// so there's no CurrentUser-gated variant of these routes.
@Feature('partners')
@Controller('partners')
@UseGuards(ActiveMemberGuard)
export class PartnersController {
  constructor(private readonly partnersService: PartnersService) {}

  @Get()
  list(@Query() query: ListPartnersQuery) {
    return this.partnersService.list(query);
  }

  @Get(':slug')
  getBySlug(@Param('slug') slug: string) {
    return this.partnersService.getBySlug(slug);
  }
}

// Split from `PartnersController` because its three routes have three
// different guard shapes: any active member may submit an application, but
// only admins may list or triage the queue (mirrors `AdminTitlesController`
// being split out from `CinemaController` for the same reason).
@Feature('partners')
@Controller('partner-applications')
export class PartnerApplicationsController {
  constructor(private readonly partnersService: PartnersService) {}

  @Post()
  @UseGuards(ActiveMemberGuard)
  submit(
    @CurrentUser() user: CurrentUserData,
    @Body() dto: CreatePartnerApplicationDto,
  ) {
    return this.partnersService.submitApplication(user.userId, dto);
  }

  @Get()
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  listApplications() {
    return this.partnersService.listApplications();
  }

  @Patch(':id')
  @UseGuards(ActiveMemberGuard, RolesGuard)
  @Roles(UserRole.Admin)
  triage(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TriagePartnerApplicationDto,
  ) {
    return this.partnersService.triage(id, dto.action, dto.note);
  }
}
