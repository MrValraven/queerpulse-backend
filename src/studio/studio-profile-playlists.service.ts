import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MemberLookup } from '../common/member-ref';
import { Profile } from '../users/entities/profile.entity';
import { UpdateStudioProfilePlaylistsDto } from './dto/update-studio-profile-playlists.dto';
import { StudioProfilePlaylistSetting } from './entities/studio-profile-playlist-setting.entity';
import { studioProfilePlaylistError } from './studio-profile-playlists.errors';
import { StudioPlaylistReadsService } from './studio-playlist-reads.service';
import { StudioPlaylistCard } from './studio-playlist-response';
import { StudioPage } from './studio-response';

export interface StudioProfilePlaylists {
  isShown: boolean;
  featuredIds: string[];
  items: StudioPlaylistCard[];
}

const EMPTY_PAGE: StudioPage<StudioPlaylistCard> = {
  items: [],
  pageInfo: { hasMore: false, nextCursor: null },
};

/**
 * The member's choice of which Studio playlists their public profile shows.
 * `listForMember` applies the choice to the profile read, for visitors and
 * for the owner alike, so the owner sees what visitors see.
 */
@Injectable()
export class StudioProfilePlaylistsService {
  constructor(
    @InjectRepository(StudioProfilePlaylistSetting)
    private readonly settings: Repository<StudioProfilePlaylistSetting>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly playlistReads: StudioPlaylistReadsService,
  ) {}

  async get(userId: string): Promise<StudioProfilePlaylists> {
    const [setting, items] = await Promise.all([
      this.settings.findOne({ where: { userId } }),
      this.playlistReads.listFeaturableByMember(userId),
    ]);
    const featurableIds = new Set(items.map((card) => card.id));
    return {
      isShown: setting?.isShown ?? true,
      // A playlist deleted since it was featured is dropped here.
      featuredIds: (setting?.featuredIds ?? []).filter((id) =>
        featurableIds.has(id),
      ),
      items,
    };
  }

  async update(
    userId: string,
    dto: UpdateStudioProfilePlaylistsDto,
  ): Promise<StudioProfilePlaylists> {
    const items = await this.playlistReads.listFeaturableByMember(userId);
    const featurableIds = new Set(items.map((card) => card.id));
    if (dto.featuredIds.some((id) => !featurableIds.has(id))) {
      throw studioProfilePlaylistError('studio_profile_playlist_not_yours');
    }
    await this.settings.upsert(
      {
        userId,
        isShown: dto.isShown,
        featuredIds: dto.featuredIds,
        updatedAt: new Date(),
      },
      ['userId'],
    );
    return { isShown: dto.isShown, featuredIds: dto.featuredIds, items };
  }

  /** `GET studio/members/:slug/playlists` with the member's choice applied. */
  async listForMember(
    viewerId: string,
    memberSlug: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioPlaylistCard>> {
    const memberUserId = await new MemberLookup(this.profiles).userIdForSlug(
      memberSlug,
    );
    if (!memberUserId) {
      return EMPTY_PAGE;
    }
    const setting = await this.settings.findOne({
      where: { userId: memberUserId },
    });
    if (setting && !setting.isShown) {
      return EMPTY_PAGE;
    }
    const featuredIds = setting?.featuredIds ?? [];
    if (featuredIds.length === 0) {
      return this.playlistReads.listCreditedToMember(
        viewerId,
        memberSlug,
        cursor,
      );
    }
    // The featured list is at most 12, inside one page, so it has no cursor.
    const page = await this.playlistReads.listCreditedToMember(
      viewerId,
      memberSlug,
      undefined,
      featuredIds,
    );
    const orderOf = new Map(featuredIds.map((id, index) => [id, index]));
    const items = [...page.items].sort(
      (first, second) =>
        (orderOf.get(first.id) ?? 0) - (orderOf.get(second.id) ?? 0),
    );
    return { items, pageInfo: { hasMore: false, nextCursor: null } };
  }
}
