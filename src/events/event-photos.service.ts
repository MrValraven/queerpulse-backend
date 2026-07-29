import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { MemberLookup } from '../common/member-ref';
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
  ) {
    this.memberLookup = new MemberLookup(this.profiles);
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
    const [view] = await toEventPhotoViews(
      [saved],
      this.storage,
      this.memberLookup,
    );
    // invariant: toEventPhotoViews returns one view per input row, and exactly
    // one row (`saved`) was passed in.
    return view!;
  }

  async list(
    slug: string,
    user: CurrentUserData,
  ): Promise<{ photos: EventPhotoView[] }> {
    const event = await this.loadEventOr404(slug);
    if (!(await this.isParticipant(event, user.userId))) {
      throw new ForbiddenException('Event photos are for attendees only');
    }
    const rows = await this.photos.find({
      where: { eventId: event.id },
      order: { createdAt: 'DESC' },
    });
    const photos = await toEventPhotoViews(
      rows,
      this.storage,
      this.memberLookup,
    );
    return { photos };
  }

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
