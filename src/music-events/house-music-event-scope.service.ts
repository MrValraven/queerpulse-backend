import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Event } from '../events/entities/event.entity';
import { GatheringFamily } from '../events/gathering-family';
import { houseMusicEventError } from '../events/house-music-event-errors';
import { GoTogetherHouseService } from '../go-together/go-together-house.service';

/** An event the house account hosts in the Music family, with the house id. */
export interface HouseMusicEventScope {
  event: Event;
  houseUserId: string;
}

/** True when the house account hosts the event and it is filed under Music. */
export function isHouseMusicEvent(
  event: Pick<Event, 'hostId' | 'gatheringFamily'>,
  houseUserId: string,
): boolean {
  return (
    event.hostId === houseUserId &&
    event.gatheringFamily === GatheringFamily.Music
  );
}

/**
 * Loads an event by slug and answers 404 `music_event_not_found` unless the
 * house account hosts it in Music. Every music-events route runs this first,
 * so a member's own event is never reachable through the staff routes.
 */
@Injectable()
export class HouseMusicEventScopeService {
  constructor(
    @InjectRepository(Event)
    private readonly eventRepository: Repository<Event>,
    private readonly houseService: GoTogetherHouseService,
  ) {}

  houseUserId(): Promise<string> {
    return this.houseService.houseUserId();
  }

  async loadOrNotFound(slug: string): Promise<HouseMusicEventScope> {
    const houseUserId = await this.houseService.houseUserId();
    const event = await this.eventRepository.findOne({ where: { slug } });
    if (!event || !isHouseMusicEvent(event, houseUserId)) {
      throw houseMusicEventError('music_event_not_found');
    }
    return { event, houseUserId };
  }
}
