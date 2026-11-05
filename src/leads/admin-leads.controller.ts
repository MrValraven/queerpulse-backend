import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import {
  CurrentUser,
  CurrentUserData,
} from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { StaffRoles } from '../auth/decorators/staff-roles.decorator';
import { ActiveMemberGuard } from '../auth/guards/active-member.guard';
import { RolesOrStaffGuard } from '../auth/guards/roles-or-staff.guard';
import { UserRole } from '../users/entities/user.entity';
import {
  CreateLeadDto,
  LeadNoteDto,
  LeadPersonaSearchQuery,
  ListLeadsQuery,
  UpdateLeadDto,
} from './dto/leads.dto';
import { LeadEntriesService } from './lead-entries.service';
import { LeadPersonaService } from './lead-persona.service';
import { LeadsService } from './leads.service';

/** Swagger text of the field codes a create or update can answer with 400. */
const LEAD_FIELD_CODES =
  '`LEAD_NAME_REQUIRED`, `LEAD_NAME_TOO_LONG`, `LEAD_TYPE_INVALID`, `LEAD_STAGE_INVALID`, `LEAD_LOCATION_TOO_LONG`, `LEAD_EMAIL_INVALID`, `LEAD_PHONE_TOO_LONG`, `LEAD_LINK_INVALID` (with `index`), `LEAD_LINK_TOO_LONG` (with `index`), `LEAD_TOO_MANY_LINKS`, `LEAD_FOLLOW_UP_INVALID`';

/**
 * The staff leads directory: acts, venues and businesses staff want to bring
 * onto the platform, with their links, a dated entry log, stages, follow-ups
 * and a link to a listed persona.
 *
 * Admin tier or the `music_manager_producer` staff grant. The class carries
 * `@Roles(UserRole.Admin)` and `@StaffRoles('music_manager_producer')`, so
 * `RolesOrStaffGuard` lets an Admin through on the tier and a grant holder
 * through on the grant, and refuses a Moderator who holds no grant. No handler
 * adds a role or a grant. The class carries no feature tag and no analytics or
 * cache interceptor, and leads paths are kept out of the request log, metrics
 * and Sentry (`leads-request-log.ts`).
 *
 * Route table. Every write except the lead delete answers the full refreshed
 * lead, and every refusal carries a `code`:
 *
 *   GET    admin/leads                            one list page
 *   GET    admin/leads/due-count                  follow-ups due today
 *   GET    admin/leads/personas/search            persona picker, at most 20
 *   POST   admin/leads                            add a lead
 *   GET    admin/leads/:id                        one lead with its entries
 *   PATCH  admin/leads/:id                        change a lead
 *   DELETE admin/leads/:id                        delete a lead
 *   POST   admin/leads/:id/entries                add a note
 *   PATCH  admin/leads/:id/entries/:entryId       edit a note
 *   DELETE admin/leads/:id/entries/:entryId       delete a note
 *
 * Reason codes per route, in check order:
 *
 *   GET    /             LEAD_STAGE_INVALID, LEAD_TYPE_INVALID,
 *                        LEAD_CURSOR_INVALID
 *   POST   /             the field codes, LEAD_NOTE_EMPTY, LEAD_NOTE_TOO_LONG,
 *                        LEAD_EMAIL_TAKEN, LEAD_LINK_TAKEN
 *   GET    :id           LEAD_NOT_FOUND
 *   PATCH  :id           LEAD_NOT_FOUND (malformed id), the field codes,
 *                        LEAD_PERSONA_NOT_FOUND (400, malformed persona id),
 *                        LEAD_NOT_FOUND, LEAD_EMAIL_TAKEN, LEAD_LINK_TAKEN,
 *                        LEAD_PERSONA_NOT_FOUND (404), LEAD_PERSONA_TAKEN,
 *                        LEAD_PERSONA_NOT_LISTED
 *   DELETE :id           LEAD_NOT_FOUND
 *   POST   :id/entries   LEAD_NOT_FOUND (malformed id), LEAD_NOTE_EMPTY,
 *                        LEAD_NOTE_TOO_LONG, LEAD_NOT_FOUND
 *   PATCH  :id/entries/:entryId
 *                        LEAD_NOT_FOUND (malformed id), LEAD_NOTE_NOT_FOUND
 *                        (malformed entry id), LEAD_NOTE_EMPTY,
 *                        LEAD_NOTE_TOO_LONG, LEAD_NOT_FOUND,
 *                        LEAD_NOTE_NOT_FOUND, LEAD_ENTRY_NOT_EDITABLE,
 *                        LEAD_NOTE_NOT_YOURS
 *   DELETE :id/entries/:entryId
 *                        the PATCH order without the two body codes
 *
 * `:id` and `:entryId` are plain strings: the services check the uuid shape
 * and answer the route's not-found code, so no pipe can answer a generic 400.
 * The literal `due-count` and `personas/search` routes are declared before
 * `:id` so Nest matches the literal.
 */
@ApiTags('Admin - Leads')
@ApiCookieAuth()
@ApiUnauthorizedResponse({ description: 'Not authenticated.' })
@ApiForbiddenResponse({
  description:
    'Requires the admin tier or the music_manager_producer staff grant.',
})
@Controller('admin/leads')
@UseGuards(ActiveMemberGuard, RolesOrStaffGuard)
@Roles(UserRole.Admin)
@StaffRoles('music_manager_producer')
export class AdminLeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly leadEntries: LeadEntriesService,
    private readonly leadPersonas: LeadPersonaService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'List leads',
    description:
      'One page of at most 50 leads, due follow-ups first, then the most recently changed. `stageCounts` and `totalCount` count every stage under the `q` and `type` filters. Send `nextCursor` back as `cursor`, with the same filters, for the next page.',
  })
  @ApiOkResponse({ description: 'The page, its next cursor and the counts.' })
  @ApiBadRequestResponse({
    description:
      'Code `LEAD_STAGE_INVALID`, `LEAD_TYPE_INVALID` or `LEAD_CURSOR_INVALID`, checked in this order.',
  })
  listLeads(@Query() query: ListLeadsQuery) {
    return this.leads.listLeads(query);
  }

  @Get('due-count')
  @ApiOperation({
    summary: 'Count leads with a follow-up due',
    description:
      'Leads in an open stage whose follow-up day is today or earlier, read in Europe/Lisbon.',
  })
  @ApiOkResponse({ description: '`{ count }`.' })
  dueCount() {
    return this.leads.dueCount();
  }

  @Get('personas/search')
  @ApiOperation({
    summary: 'Search personas to link to a lead',
    description:
      'Personas the public directory shows, at most 20, each with the lead it is linked to, if any. A `q` starting with @ searches handles by prefix. A blank `q` answers an empty list and a `q` over 100 characters is cut to its first 100.',
  })
  @ApiOkResponse({ description: 'The matching personas.' })
  searchPersonas(@Query() query: LeadPersonaSearchQuery) {
    return this.leadPersonas.searchPersonas(query.q);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a lead',
    description:
      'Writes the lead, its `created` entry and the first note when one is given.',
  })
  @ApiCreatedResponse({ description: 'The new lead with its entries.' })
  @ApiBadRequestResponse({
    description: `Code ${LEAD_FIELD_CODES}, \`LEAD_NOTE_EMPTY\` or \`LEAD_NOTE_TOO_LONG\`, checked in this order.`,
  })
  @ApiConflictResponse({
    description:
      'Code `LEAD_EMAIL_TAKEN` (with `leadId`, `leadName`) or `LEAD_LINK_TAKEN` (with `leadId`, `leadName`, `index`).',
  })
  createLead(
    @CurrentUser() user: CurrentUserData,
    @Body() body: CreateLeadDto,
  ) {
    return this.leads.createLead(user, body);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Load a lead',
    description:
      'The lead, its linked persona and every entry, newest first, each with its author and whether the caller can edit it.',
  })
  @ApiOkResponse({ description: 'The lead with its entries.' })
  @ApiNotFoundResponse({
    description:
      'Code `LEAD_NOT_FOUND`: no lead has that id, or it is no uuid.',
  })
  getLead(@Param('id') leadId: string, @CurrentUser() user: CurrentUserData) {
    return this.leads.getLead(leadId, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a lead',
    description:
      'An absent property is left as it is. A stage change and a persona link or unlink each write an entry; sending the current value changes nothing.',
  })
  @ApiOkResponse({ description: 'The refreshed lead with its entries.' })
  @ApiBadRequestResponse({
    description: `Code ${LEAD_FIELD_CODES}, or \`LEAD_PERSONA_NOT_FOUND\` when \`linkedSubprofileId\` is no uuid.`,
  })
  @ApiNotFoundResponse({
    description: 'Code `LEAD_NOT_FOUND` or `LEAD_PERSONA_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description:
      'Code `LEAD_EMAIL_TAKEN`, `LEAD_LINK_TAKEN`, `LEAD_PERSONA_TAKEN` (each with the other lead) or `LEAD_PERSONA_NOT_LISTED` (with the persona `publicState`).',
  })
  updateLead(
    @Param('id') leadId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() body: UpdateLeadDto,
  ) {
    return this.leads.updateLead(leadId, user, body);
  }

  @Delete(':id')
  @ApiOperation({
    summary: 'Delete a lead',
    description: 'Deletes the lead and every entry on it.',
  })
  @ApiOkResponse({ description: '`{ ok: true }`.' })
  @ApiNotFoundResponse({
    description:
      'Code `LEAD_NOT_FOUND`: no lead has that id, or it is no uuid.',
  })
  deleteLead(
    @Param('id') leadId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.leads.deleteLead(leadId, user);
  }

  @Post(':id/entries')
  @ApiOperation({
    summary: 'Add a note to a lead',
    description: 'The caller is the author of the note.',
  })
  @ApiCreatedResponse({ description: 'The refreshed lead with its entries.' })
  @ApiBadRequestResponse({
    description: 'Code `LEAD_NOTE_EMPTY` or `LEAD_NOTE_TOO_LONG`.',
  })
  @ApiNotFoundResponse({
    description:
      'Code `LEAD_NOT_FOUND`: no lead has that id, or it is no uuid.',
  })
  addNote(
    @Param('id') leadId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() body: LeadNoteDto,
  ) {
    return this.leadEntries.addNote(leadId, user, body);
  }

  @Patch(':id/entries/:entryId')
  @ApiOperation({
    summary: 'Edit a note on a lead',
    description:
      'Its author or an Admin can edit a note. Other entries stay as the record. An unchanged body changes nothing.',
  })
  @ApiOkResponse({ description: 'The refreshed lead with its entries.' })
  @ApiBadRequestResponse({
    description: 'Code `LEAD_NOTE_EMPTY` or `LEAD_NOTE_TOO_LONG`.',
  })
  @ApiForbiddenResponse({
    description:
      'Code `LEAD_NOTE_NOT_YOURS`: the caller did not write the note and is no Admin.',
  })
  @ApiNotFoundResponse({
    description: 'Code `LEAD_NOT_FOUND` or `LEAD_NOTE_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description: 'Code `LEAD_ENTRY_NOT_EDITABLE`: the entry is no note.',
  })
  editNote(
    @Param('id') leadId: string,
    @Param('entryId') entryId: string,
    @CurrentUser() user: CurrentUserData,
    @Body() body: LeadNoteDto,
  ) {
    return this.leadEntries.editNote(leadId, entryId, user, body);
  }

  @Delete(':id/entries/:entryId')
  @ApiOperation({
    summary: 'Delete a note from a lead',
    description: 'Its author or an Admin can delete a note.',
  })
  @ApiOkResponse({ description: 'The refreshed lead with its entries.' })
  @ApiForbiddenResponse({
    description:
      'Code `LEAD_NOTE_NOT_YOURS`: the caller did not write the note and is no Admin.',
  })
  @ApiNotFoundResponse({
    description: 'Code `LEAD_NOT_FOUND` or `LEAD_NOTE_NOT_FOUND`.',
  })
  @ApiConflictResponse({
    description: 'Code `LEAD_ENTRY_NOT_EDITABLE`: the entry is no note.',
  })
  deleteNote(
    @Param('id') leadId: string,
    @Param('entryId') entryId: string,
    @CurrentUser() user: CurrentUserData,
  ) {
    return this.leadEntries.deleteNote(leadId, entryId, user);
  }
}
