import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DEFAULT_REMINDER_LEAD_MINUTES,
  MemberEventReminderPreferences,
} from './entities/member-event-reminder-preferences.entity';
import { UpdateReminderPreferencesDto } from './dto/update-reminder-preferences.dto';

export interface ReminderPreferencesDTO {
  leadMinutes: number;
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
}
