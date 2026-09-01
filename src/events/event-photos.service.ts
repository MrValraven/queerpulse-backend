import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MemberLookup } from '../common/member-ref';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { MediaCropService } from '../media-crops/media-crops.service';
import { Profile } from '../users/entities/profile.entity';
import { StorageService } from '../storage/storage.service';
import { parseStorageKey } from '../storage/storage-key';
import { UPLOAD_KIND_SPECS } from '../storage/upload-kinds';
import { AttachEventPhotoDto } from './dto/attach-event-photo.dto';
import { EventPhoto } from './entities/event-photo.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { Event } from './entities/event.entity';
import { EventPhotoView, toEventPhotoViews } from './event-photo-response';
import { EventsService } from './events.service';

const GATHERING_PHOTO_PREFIX = UPLOAD_KIND_SPECS['gathering-photo'].prefix;

@Injectable()
export class EventPhotosService {
  private readonly logger = new Logger(EventPhotosService.name);
  private readonly memberLookup: MemberLookup;

  constructor(
    @InjectRepository(EventPhoto)
    private readonly photos: Repository<EventPhoto>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(EventRsvp)
    private readonly rsvps: Repository<EventRsvp>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly eventsService: EventsService,
    private readonly storage: StorageService,
    // Batched crop lookup (`MediaCropService.getMany`) for a photo's `crop`,
    // and `remove()` for dropping that crop when the photo is taken down.
    private readonly mediaCropService: MediaCropService,
    // A moderator `hide_content`/`remove_content` on an `event_photo` subject
    // has to make the photograph actually disappear from the album. Read
    // through this on EVERY path that hands a photo back.
    private readonly contentModeration: ContentModerationService,
  ) {
    this.memberLookup = new MemberLookup(this.profiles);
  }

  // The taxonomy code one album photograph is reported and taken down under
  // (`ReportSubjectType.EventPhoto`), keyed by the `event_photos` row's uuid.
  // It exists because `event` is the wrong grain: acting on a whole gathering
  // over one image takes the gathering down with it.
  private static readonly PHOTO_SUBJECT_TYPE = 'event_photo';

  /**
   * NOT EXISTS predicate dropping any photo under an `event_photo` takedown
   * from a photo query builder. In-query rather than post-fetch so the album's
   * `take(200)` cap counts only photographs the album will actually show.
   *
   * Hidden AND removed both drop the tile outright. There is no per-viewer
   * staff role on this surface and no tombstone to render: a photograph is
   * either shown or it is not, and the organizers who would be the "staff" here
   * are, on the reports that matter most, the people being complained about.
   * That is the whole reason this subject exists at its own grain, so a
   * takedown withholds the photo from EVERY viewer, organizers included.
   *
   * Mirrors `DirectoryService.excludeModeratedReviews` /
   * `excludeModeratedQuestions` exactly, including their contract:
   * `photoIdColumn` is spliced verbatim into raw SQL, so pass an actual column
   * reference and never user input, and it is cast to text because
   * `content_moderation.subject_id` is varchar while a photo id is uuid.
   */
  private excludeModeratedPhotos(
    queryBuilder: SelectQueryBuilder<EventPhoto>,
    photoIdColumn: string,
  ): void {
    queryBuilder.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "cmp"
        WHERE "cmp"."subject_type" = :photoSubjectType
          AND "cmp"."subject_id" = ${photoIdColumn}::text
          AND ("cmp"."hidden_at" IS NOT NULL OR "cmp"."removed_at" IS NOT NULL)
      )`,
      { photoSubjectType: EventPhotosService.PHOTO_SUBJECT_TYPE },
    );
  }

  /**
   * Post-query twin of {@link excludeModeratedPhotos} for the single-row read
   * paths that already hold their row. Same hidden-OR-removed rule.
   */
  private async isPhotoTakenDown(photoId: string): Promise<boolean> {
    const state = await this.contentModeration.stateFor(
      EventPhotosService.PHOTO_SUBJECT_TYPE,
      photoId,
    );
    return state.hidden || state.removed;
  }

  async attach(
    slug: string,
    user: CurrentUserData,
    dto: AttachEventPhotoDto,
  ): Promise<EventPhotoView> {
    const event = await this.loadEventOr404(slug);
    // Attach is organizer-only. Ownership of `dto.key` is already guaranteed by
    // the global StorageKeyOwnershipInterceptor; we only confirm it is a
    // gathering photo (not, say, an avatar key the member also owns).
    if (!(await this.eventsService.isOrganizer(event.id, user.userId))) {
      throw new ForbiddenException('Only organizers can add event photos');
    }
    this.assertGatheringPhotoKey(dto.key);
    // `storage_key` is globally unique, so a given uploaded object belongs to
    // exactly one event. Handle a repeat POST explicitly rather than tripping
    // the constraint: reject if the key is already on a DIFFERENT event (a
    // silent 200 would misreport it as attached here), and treat a same-event
    // repeat as an idempotent update — refresh the caption if it changed.
    const existing = await this.photos.findOne({
      where: { storageKey: dto.key },
    });
    let saved: EventPhoto;
    if (existing) {
      if (existing.eventId !== event.id) {
        throw new ConflictException(
          'This photo is already attached to another event',
        );
      }
      // A repeat POST of a key a moderator has taken down would answer 200
      // with a photo view the album then refuses to list. Refuse the write
      // instead, so a takedown is never handed back as a fresh attachment.
      if (await this.isPhotoTakenDown(existing.id)) {
        throw new ConflictException('This photo is no longer available');
      }
      if (dto.caption !== undefined && dto.caption !== existing.caption) {
        existing.caption = dto.caption;
        saved = await this.photos.save(existing);
      } else {
        saved = existing;
      }
    } else {
      saved = await this.photos.save(
        this.photos.create({
          eventId: event.id,
          storageKey: dto.key,
          uploaderId: user.userId,
          caption: dto.caption ?? null,
        }),
      );
    }
    const crops = await this.mediaCropService.getMany([saved.storageKey]);
    const [view] = await toEventPhotoViews(
      [saved],
      this.storage,
      this.memberLookup,
      crops,
    );
    // invariant: toEventPhotoViews returns one view per input row, and exactly
    // one row (`saved`) was passed in.
    return view!;
  }

  /**
   * The gathering's album, for participants only. Every photo under an
   * `event_photo` takedown is dropped in-query (see
   * {@link excludeModeratedPhotos}), so a moderator hiding one photograph
   * makes that photograph disappear for everyone, the organizers included.
   * This is the album's only read path in the backend: no other endpoint
   * returns a gathering photo, counts one, or draws a cover from one (a
   * gathering's cover comes off the event row's own `coverImageUrl`
   * column, never off the album).
   */
  async list(
    slug: string,
    user: CurrentUserData,
  ): Promise<{ photos: EventPhotoView[] }> {
    const event = await this.loadEventOr404(slug);
    if (!(await this.isParticipant(event, user.userId))) {
      throw new ForbiddenException('Event photos are for attendees only');
    }
    const photosQuery = this.photos
      .createQueryBuilder('photo')
      .where('photo.eventId = :eventId', { eventId: event.id })
      .orderBy('photo.createdAt', 'DESC')
      // Bound the result set: an event's gallery is browsed as a strip, not
      // paginated, so cap it rather than let one event load unboundedly.
      .take(200);
    // Moderator takedowns are applied BEFORE the cap, so a taken-down photo
    // costs the album a slot it would otherwise have filled with a real one.
    this.excludeModeratedPhotos(photosQuery, 'photo.id');
    const rows = await photosQuery.getMany();
    // ONE batched crop lookup for every photo in the gallery — never a
    // per-photo query.
    const crops = await this.mediaCropService.getMany(
      rows.map((row) => row.storageKey),
    );
    const photos = await toEventPhotoViews(
      rows,
      this.storage,
      this.memberLookup,
      crops,
    );
    return { photos };
  }

  /**
   * Take a photo out of a gathering's album. "Removed from the album" has to
   * mean removed, so this drops all three pieces the photo is made of: the
   * stored object in the bucket, the `media_crops` row keyed on that storage
   * key, and the `event_photos` row.
   *
   * ## Why the object goes FIRST, and what happens when a step fails
   *
   * Object deletion is not transactional with Postgres. One half can survive
   * the other, and the ORDER is what decides WHICH half survives.
   *
   * Everywhere else in this codebase that drops an image reference the DB write
   * commits first and the object delete is a best-effort afterthought:
   * `ListingsService.deleteOrphanedObjects`, `CommunityPostsService`'s
   * delete-on-replace, `DirectoryService.deleteOrphanedReviewPhoto`. That order
   * is right for those callers because the write is a REPLACE that has already
   * been acknowledged to the member and cannot be rolled back, so the object is
   * orphaned whatever happens next.
   *
   * A take-down is the other shape, and it inverts the preference:
   *
   *  - Rows first, object best-effort: a bucket failure leaves the file live
   *    and still fetchable through `GET /files/<key>` with no row pointing at
   *    it. That is precisely the orphan this method exists to stop, and it is
   *    unrecoverable from here: the row is gone, so a second DELETE 404s and
   *    the member has no way to ask again. The orphan sweeper
   *    (`StorageMaintenanceService`) is no safety net either, being both
   *    disabled and dry-run by default.
   *  - Object first, rows after: a bucket failure removes nothing at all. The
   *    photo is still in the album, the member can see the take-down did not
   *    happen, and pressing remove again reruns every step. A failure BETWEEN
   *    the object delete and the row delete leaves a tile whose presigned URL
   *    404s, which is visible, carries no image, and is cleared by that same
   *    retry, because `DeleteObject` on a key that is already gone succeeds.
   *
   * These are photographs of identifiable people at a queer gathering. "The
   * file survived and you cannot ask again" is the failure to design away, so
   * the object goes first and a storage error propagates rather than being
   * swallowed. Every step is safe to repeat, so a half-failed take-down is
   * always retryable through this same endpoint.
   *
   * A second DELETE after a fully successful removal still 404s, which is
   * correct: the photo is genuinely gone.
   */
  async remove(
    slug: string,
    user: CurrentUserData,
    photoId: string,
  ): Promise<{ ok: true }> {
    const event = await this.loadEventOr404(slug);
    const photo = await this.photos.findOne({ where: { id: photoId } });
    if (!photo || photo.eventId !== event.id) {
      throw new NotFoundException('Photo not found');
    }
    const isUploader = photo.uploaderId === user.userId;
    const isOrganizer = await this.eventsService.isOrganizer(
      event.id,
      user.userId,
    );
    if (!isUploader && !isOrganizer) {
      throw new ForbiddenException('You cannot remove this photo');
    }
    // 1. The stored object. A genuine bucket failure throws here and aborts the
    //    whole take-down with both rows intact, which is what keeps the retry
    //    above possible. `deleteObjectByReference` returns false WITHOUT
    //    touching storage only for a value that is not one of our keys, which
    //    `attach` cannot write (`assertGatheringPhotoKey`); if a row ever holds
    //    one there is no object of ours to remove, so the rows still go.
    const wasObjectDeleted = await this.storage.deleteObjectByReference(
      photo.storageKey,
    );
    if (!wasObjectDeleted) {
      this.logger.warn(
        `Event photo ${photo.id} held a storage value that is not a key; removed its rows only.`,
      );
    }
    // 2. The crop rect. `media_crops` is keyed on the storage key and has no FK
    //    to `event_photos`, so nothing cascades it away. It has to go before
    //    the album row: once that row is gone no retry can find the key again,
    //    and the crop would dangle forever.
    await this.mediaCropService.remove(photo.storageKey);
    // 3. The album row, last, so any earlier failure leaves it standing as the
    //    handle a retry addresses.
    await this.photos.delete({ id: photo.id });
    return { ok: true };
  }

  private async isParticipant(event: Event, userId: string): Promise<boolean> {
    if (await this.eventsService.isOrganizer(event.id, userId)) {
      return true;
    }
    const rsvp = await this.rsvps.findOne({
      where: { eventId: event.id, userId, status: RsvpStatus.Going },
    });
    return rsvp !== null;
  }

  private assertGatheringPhotoKey(key: string): void {
    const kind = parseStorageKey(key);
    if (!kind || kind.prefix !== GATHERING_PHOTO_PREFIX) {
      throw new ForbiddenException('Not a gathering photo');
    }
  }

  private async loadEventOr404(slug: string): Promise<Event> {
    const event = await this.events.findOne({ where: { slug } });
    if (!event) {
      throw new NotFoundException('Event not found');
    }
    return event;
  }
}
