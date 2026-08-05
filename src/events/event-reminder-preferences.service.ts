import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_EVENT_EMAILS_ENABLED,
  DEFAULT_EVENT_VISIBILITY,
  DEFAULT_REMINDER_LEAD_MINUTES,
  EventVisibility,
  MemberEventReminderPreferences,
} from './entities/member-event-reminder-preferences.entity';
import { UpdateReminderPreferencesDto } from './dto/update-reminder-preferences.dto';
import { UpdateEventSettingsDto } from './dto/update-event-settings.dto';

export interface ReminderPreferencesDTO {
  leadMinutes: number;
}

export interface EventSettingsDTO {
  defaultEventVisibility: EventVisibility;
  eventEmailsEnabled: boolean;
}

@Injectable()
export class EventReminderPreferencesService {
  constructor(
    @InjectRepository(MemberEventReminderPreferences)
    private readonly preferences: Repository<MemberEventReminderPreferences>,
  ) {}

  // A GET must never insert a row — a member who has merely opened event
  // settings should not acquire a preferences row (see `PreferencesService`).
  // No row is a coherent state with a correct answer: the default lead.
  async get(userId: string): Promise<ReminderPreferencesDTO> {
    const existing = await this.preferences.findOne({ where: { userId } });
    return {
      leadMinutes: existing?.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES,
    };
  }

  // Upsert: reuse the existing row (preserving createdAt) or start a fresh one.
  async update(
    userId: string,
    dto: UpdateReminderPreferencesDto,
  ): Promise<ReminderPreferencesDTO> {
    const row =
      (await this.preferences.findOne({ where: { userId } })) ??
      this.preferences.create({ userId });
    row.leadMinutes = dto.leadMinutes;
    const saved = await this.preferences.save(row);
    return { leadMinutes: saved.leadMinutes };
  }

  // Like `get`, a read never inserts a row — no row is the coherent "defaults"
  // state (visibility = connections, emails on), matching the frontend's
  // `DEFAULT_PREFS`.
  async getSettings(userId: string): Promise<EventSettingsDTO> {
    const existing = await this.preferences.findOne({ where: { userId } });
    return {
      defaultEventVisibility:
        existing?.defaultEventVisibility ?? DEFAULT_EVENT_VISIBILITY,
      eventEmailsEnabled:
        existing?.eventEmailsEnabled ?? DEFAULT_EVENT_EMAILS_ENABLED,
    };
  }

  // Upsert into the same singleton row the lead time lives on. A fresh row
  // leaves `leadMinutes` unset so its column default (1 day) applies, exactly
  // as the reminder upsert leaves these settings columns to their defaults.
  async updateSettings(
    userId: string,
    dto: UpdateEventSettingsDto,
  ): Promise<EventSettingsDTO> {
    const row =
      (await this.preferences.findOne({ where: { userId } })) ??
      this.preferences.create({ userId });
    row.defaultEventVisibility = dto.defaultEventVisibility;
    row.eventEmailsEnabled = dto.eventEmailsEnabled;
    const saved = await this.preferences.save(row);
    return {
      defaultEventVisibility: saved.defaultEventVisibility,
      eventEmailsEnabled: saved.eventEmailsEnabled,
    };
  }
}
