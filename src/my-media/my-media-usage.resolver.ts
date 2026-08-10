import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Profile } from '../users/entities/profile.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { MagazineIssue } from '../magazine/entities/magazine-issue.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { Conversation } from '../messaging/entities/conversation.entity';
import { Listing } from '../listings/entities/listing.entity';

export const MY_MEDIA_USAGE_RESOLVER = 'MY_MEDIA_USAGE_RESOLVER';

/**
 * Stable, language-neutral slug for WHERE an uploaded key is still referenced.
 * The frontend translates it (`settings:uploads.usedAs.<slug>`) — the backend
 * deliberately never returns human prose, so the "in use" warning localises.
 */
export type MyMediaUsage =
  'profile-photo' | 'showcase' | 'story-cover' | 'event' | 'group' | 'listing';

export interface MyMediaUsageResolver {
  /** Maps each in-use key -> a usage slug; absent keys are not in use. */
  resolve(userId: string, keys: string[]): Promise<Map<string, MyMediaUsage>>;
}

// A stored reference may be the raw storage key (`avatars/<id>/x.jpg`) or a
// `/files/<key>` URL (see `MyMediaService.listMine`'s `fileUrl` and
// `files.controller.ts`). Normalise both forms to the bare key before
// comparing so either representation matches the caller's candidate keys.
const FILES_PREFIX = '/files/';
function toBareKey(value: string): string {
  return value.startsWith(FILES_PREFIX)
    ? value.slice(FILES_PREFIX.length)
    : value;
}

/**
 * Best-effort "is this uploaded key still referenced anywhere" check for
 * `GET /my-media` (task 2 of the my-media feature). Only ever queries the
 * caller's own rows (scoped by userId/uploaderId/createdBy/ownerId), and only
 * ever matches against the caller's OWN candidate keys passed in — so every
 * lookup is bounded by what the user uploaded. Best-effort: it covers the
 * primary "owner" table for each upload kind, not every place a key could
 * theoretically be echoed.
 */
@Injectable()
export class MyMediaUsageResolverImpl implements MyMediaUsageResolver {
  constructor(
    @InjectRepository(Profile) private readonly profiles: Repository<Profile>,
    @InjectRepository(WorkItem)
    private readonly workItems: Repository<WorkItem>,
    @InjectRepository(MagazineIssue)
    private readonly issues: Repository<MagazineIssue>,
    @InjectRepository(EventPhoto)
    private readonly eventPhotos: Repository<EventPhoto>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
  ) {}

  async resolve(
    userId: string,
    keys: string[],
  ): Promise<Map<string, MyMediaUsage>> {
    const candidateKeys = new Set(keys.map(toBareKey));
    const used = new Map<string, MyMediaUsage>();
    if (candidateKeys.size === 0) return used;

    const mark = (
      storedValue: string | null | undefined,
      usage: MyMediaUsage,
    ) => {
      if (!storedValue) return;
      const bareKey = toBareKey(storedValue);
      if (candidateKeys.has(bareKey) && !used.has(bareKey))
        used.set(bareKey, usage);
    };

    // avatar — the caller's own profile row.
    const profile = await this.profiles.findOne({ where: { userId } });
    mark(profile?.avatarUrl, 'profile-photo');

    // work-image — the caller's portfolio/work items.
    const workItems = await this.workItems.find({ where: { userId } });
    for (const workItem of workItems) mark(workItem.imageUrl, 'showcase');

    // story-cover — MagazineIssue has no owner column, so scope by matching
    // directly on the caller's own story-cover candidate keys (both the bare
    // key and the `/files/<key>` form) rather than by an ownership filter.
    const storyCoverCandidates = keys
      .map(toBareKey)
      .filter((key) => key.startsWith('story-covers/'));
    if (storyCoverCandidates.length > 0) {
      const storedForms = storyCoverCandidates.flatMap((key) => [
        key,
        `${FILES_PREFIX}${key}`,
      ]);
      const issues = await this.issues.find({
        where: { coverUrl: In(storedForms) },
      });
      for (const issue of issues) mark(issue.coverUrl, 'story-cover');
    }

    // gathering-photo — event photos the caller uploaded.
    const eventPhotos = await this.eventPhotos.find({
      where: { uploaderId: userId },
    });
    for (const eventPhoto of eventPhotos) mark(eventPhoto.storageKey, 'event');

    // group-avatar — group conversations the caller created.
    const conversations = await this.conversations.find({
      where: { createdBy: userId },
    });
    for (const conversation of conversations) {
      mark(conversation.avatarUrl, 'group');
    }

    // listing-photo — the caller's listings. `Listing.photos` is a flat
    // `ListingPhotoSet` jsonb column ({ wide, d1, d2, vibe }: string), NOT a
    // nested `{ photos: Record<...> } ` map — each of its 4 values is itself
    // a storage reference (the sibling `alt` column holds alt text, not
    // storage refs, and is intentionally not read here).
    const listings = await this.listings.find({ where: { ownerId: userId } });
    for (const listing of listings) {
      const photoValues = Object.values(listing.photos ?? {});
      for (const photoValue of photoValues) {
        if (typeof photoValue === 'string') mark(photoValue, 'listing');
      }
    }

    return used;
  }
}
