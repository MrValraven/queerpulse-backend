import { Injectable } from '@nestjs/common';
import { ProfilesService } from '../profiles/profiles.service';
import { SavedService } from '../saved/saved.service';
import { SocialService } from '../social/social.service';
import { BootstrapResponse } from './bootstrap-response';

/**
 * Composes the four session slices into one payload.
 *
 * Deliberately no logic of its own beyond the fan-out: each slice is produced
 * by the same service method its standalone endpoint calls, so the shapes can
 * never drift from what the frontend's caches expect.
 *
 * `Promise.all` matters — serialising four independent queries would make this
 * slower than the four parallel requests it replaces, defeating the purpose.
 */
@Injectable()
export class BootstrapService {
  constructor(
    private readonly profiles: ProfilesService,
    private readonly saved: SavedService,
    private readonly social: SocialService,
  ) {}

  async getForUser(userId: string): Promise<BootstrapResponse> {
    const [profile, saved, blocks, mutes] = await Promise.all([
      this.profiles.getMine(userId),
      this.saved.list(userId, {}),
      this.social.listBlocks(userId),
      this.social.listMutes(userId),
    ]);

    return { profile, saved, blocks, mutes };
  }
}
