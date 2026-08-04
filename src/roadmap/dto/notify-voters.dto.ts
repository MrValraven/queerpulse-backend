import { IsString, MaxLength, MinLength } from 'class-validator';

// Admin `POST /admin/roadmap/items/:id/notify` body — a best-effort
// notification blast to everyone who voted for the item, and sets
// `notified: true` on it (see `RoadmapAdminService.notifyVoters`, Task A4).
export class NotifyVotersDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message!: string;
}
