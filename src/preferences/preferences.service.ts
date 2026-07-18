import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UpdatePublicProfileDto } from './dto/update-public-profile.dto';
import { UpdateWorkPreferencesDto } from './dto/update-work-preferences.dto';
import {
  DEFAULT_OUT_AT_WORK,
  DEFAULT_PUBLIC_PROFILE_ENABLED,
  DEFAULT_SAFE_ONLY,
  MemberPreferences,
} from './entities/member-preferences.entity';
import {
  PublicProfileDTO,
  WorkPreferencesDTO,
  toPublicProfileDTO,
  toWorkPreferencesDTO,
} from './preferences-response';
import { normalizeTransSupport } from './trans-support';

@Injectable()
export class PreferencesService {
  constructor(
    @InjectRepository(MemberPreferences)
    private readonly preferences: Repository<MemberPreferences>,
  ) {}

  // The unsaved shape a member who has never opened either settings page gets.
  // Reads NEVER persist this — a GET must not create rows, or every member who
  // merely loads the app acquires a preferences row. Defaults are duplicated in
  // the column definitions so a row inserted by the other endpoint gets the
  // same values.
  private defaults(userId: string): MemberPreferences {
    const row = new MemberPreferences();
    row.userId = userId;
    row.outAtWork = DEFAULT_OUT_AT_WORK;
    row.transSupport = [];
    row.safeOnly = DEFAULT_SAFE_ONLY;
    row.publicProfileEnabled = DEFAULT_PUBLIC_PROFILE_ENABLED;
    return row;
  }

  // Returns the stored row, or a synthesised default one. Deliberately not a
  // 404: "I have never touched this setting" is a coherent state with a correct
  // answer, and a safety form that errors on first open teaches members that
  // the feature is broken.
  private async loadOrDefault(userId: string): Promise<MemberPreferences> {
    const existing = await this.preferences.findOne({ where: { userId } });
    return existing ?? this.defaults(userId);
  }

  async getWorkPreferences(userId: string): Promise<WorkPreferencesDTO> {
    return toWorkPreferencesDTO(await this.loadOrDefault(userId));
  }

  // Full replace of the three work settings. Merging onto `loadOrDefault`
  // rather than inserting a bare row keeps `publicProfileEnabled` untouched —
  // the two endpoints share a row and must never clobber each other.
  async updateWorkPreferences(
    userId: string,
    dto: UpdateWorkPreferencesDto,
  ): Promise<WorkPreferencesDTO> {
    const row = await this.loadOrDefault(userId);
    row.outAtWork = dto.outAtWork;
    row.transSupport = normalizeTransSupport(dto.transSupport);
    row.safeOnly = dto.safeOnly;

    return toWorkPreferencesDTO(await this.preferences.save(row));
  }

  async getPublicProfile(userId: string): Promise<PublicProfileDTO> {
    return toPublicProfileDTO(await this.loadOrDefault(userId));
  }

  // ⚠️ THIS NOW PUBLISHES TO THE OPEN WEB. `publicProfileEnabled` stopped being
  // inert when `GET /public/profiles/:slug` landed: it is the gate on that
  // unauthenticated route (`PublicProfilesService.getBySlug`). Setting it true
  // makes the member's name, pronouns, tagline, avatar, bio, links and work
  // readable by anyone with no account — provided their `users.status` is still
  // `active` AND their `profiles.visibility` is `open`, both of which that
  // service also requires.
  //
  // Setting it false un-publishes immediately: the public route holds no cache
  // and sends `Cache-Control: no-store`, so the next request 404s.
  async updatePublicProfile(
    userId: string,
    dto: UpdatePublicProfileDto,
  ): Promise<PublicProfileDTO> {
    const row = await this.loadOrDefault(userId);
    row.publicProfileEnabled = dto.enabled;

    return toPublicProfileDTO(await this.preferences.save(row));
  }
}
