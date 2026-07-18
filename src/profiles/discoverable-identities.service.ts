import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { UpdateDiscoverableIdentitiesDto } from './dto/update-discoverable-identities.dto';
import { publishableFor, pruneDiscoverable } from './identities';

/**
 * What the member sees on the discoverability settings pane.
 *
 * `available` is what they COULD publish (the identities they hold privately,
 * minus "Prefer not to say"); `published` is what they have. Sending both means
 * the client never has to derive the toggle list from a separate private-profile
 * fetch — and, more to the point, never has to guess: a toggle rendered from a
 * stale local copy of `identities` could offer to publish something the member
 * has already retracted.
 */
export interface DiscoverableIdentitiesDTO {
  available: string[];
  published: string[];
}

@Injectable()
export class DiscoverableIdentitiesService {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
  ) {}

  private async load(userId: string): Promise<Profile> {
    const profile = await this.profiles.findOne({ where: { userId } });
    if (!profile) {
      throw new NotFoundException('Profile not found');
    }
    return profile;
  }

  /**
   * Read the published set. Runs the stored value through `pruneDiscoverable`
   * before returning it — not because the DB CHECK could have been violated, but
   * so this endpoint can never be the thing that TELLS a member an identity is
   * published when it is not. On a safety read, the cheap defensive filter is
   * worth more than the assertion that it is unreachable.
   */
  async get(userId: string): Promise<DiscoverableIdentitiesDTO> {
    const profile = await this.load(userId);
    const identities = profile.identities ?? [];
    return {
      available: publishableFor(identities),
      published: pruneDiscoverable(
        profile.discoverableIdentities ?? [],
        identities,
      ),
    };
  }

  /**
   * Full replace of the published set.
   *
   * SUBSET INVARIANT, first of three enforcement points: an identity the member
   * does not hold privately is a 422 here, listing the offenders. This one is
   * loud on purpose — unlike the profile-edit path (where a value falling out of
   * range is the member's own retraction and must be pruned silently), a client
   * asking to publish an unheld identity is a bug, and swallowing it would hide
   * a UI that offers toggles it should not.
   *
   * The write itself is a targeted `update` of the single column. Saving the
   * whole loaded entity would drag every other profile field through this
   * safety path, so a concurrent profile edit could be clobbered by a stale copy
   * — and the field most likely to be stale is `identities`, the one this
   * invariant is measured against.
   */
  async update(
    userId: string,
    dto: UpdateDiscoverableIdentitiesDto,
  ): Promise<DiscoverableIdentitiesDTO> {
    const profile = await this.load(userId);
    const identities = profile.identities ?? [];
    const allowed = new Set(publishableFor(identities));

    const rejected = [
      ...new Set(dto.identities.filter((label) => !allowed.has(label))),
    ];
    if (rejected.length) {
      throw new UnprocessableEntityException({
        reason: 'not-declared',
        identities: rejected,
        message:
          'You can only publish an identity you have added to your private identities.',
      });
    }

    // De-duplicates and fixes the order; every value is already known-allowed.
    const published = pruneDiscoverable(dto.identities, identities);
    await this.profiles.update(
      { userId },
      { discoverableIdentities: published },
    );

    return { available: publishableFor(identities), published };
  }
}
