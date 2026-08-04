import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import {
  ROADMAP_SAFETY_STATUSES,
  RoadmapColumn,
  RoadmapConfidence,
  RoadmapCost,
  RoadmapPaidKind,
  RoadmapPriority,
  RoadmapSafetyStatus,
} from '../entities/roadmap-item.entity';
import { RoadmapGuideDto } from './roadmap-guide.dto';

// Admin `POST /admin/roadmap/items` body. All three card shapes (shipped /
// building / planned) share this one DTO — like the entity, the fields
// unused for a given `column` are simply left undefined. Mirrors
// `RoadmapItemWriteBody` in the frozen contract (Appendix, plan
// `2026-08-04-admin-roadmap-redesign.md`): every `AdminRoadmapItemDTO` field
// except the server-computed ones (`id`, `liveVotes`, `ownerName`,
// `voteBreakdown`, `comments`, `updatedAt`) and the ones with their own
// endpoints (`deps` via `PATCH .../deps`; `slips` — appended automatically by
// the slip guard from `slipReason` on update, never written directly;
// `archived` — toggled only via `PATCH .../items/:id/archive`, see
// `archive-item.dto.ts`).
export class CreateRoadmapItemDto {
  @IsEnum(RoadmapColumn)
  column!: RoadmapColumn;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  category!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  description!: string;

  // The warm one-liner shown on the public roadmap ("n" in the prototype).
  @IsOptional()
  @IsString()
  @MaxLength(500)
  publicNote?: string | null;

  // Shipped only, e.g. "May 2026".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  date?: string;

  // Building only, e.g. "In progress".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  stage?: string;

  // Building only, e.g. "~Q3 2026".
  @IsOptional()
  @IsString()
  @MaxLength(100)
  eta?: string;

  // e.g. "Q3 2026". Changing this on an existing non-shipped item requires
  // `slipReason` on `UpdateRoadmapItemDto` — enforced in the admin service.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  targetQuarter?: string | null;

  // Building only, 0-100.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  progress?: number;

  @IsOptional()
  @IsEnum(RoadmapPriority)
  priority?: RoadmapPriority;

  @IsOptional()
  @IsEnum(RoadmapConfidence)
  confidence?: RoadmapConfidence;

  // A "promise" badge — publicly stated as committed, not just planned.
  @IsOptional()
  @IsBoolean()
  committed?: boolean;

  // Whether this card surfaces on the public roadmap at all. Setting this
  // `true` while `safetyStatus === 1` (required-not-cleared) is rejected by
  // the admin service, not this DTO.
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  // Seeded/backlog-origin flag: at least one member asked for this.
  @IsOptional()
  @IsBoolean()
  requested?: boolean;

  // Whether voters were already notified this card moved/shipped.
  @IsOptional()
  @IsBoolean()
  notified?: boolean;

  // Flags a card as a spike/investigation rather than committed scope.
  @IsOptional()
  @IsBoolean()
  spikeFlag?: boolean;

  // 0 = none, 1 = required, 2 = cleared. A plain union, not a Postgres/TS
  // enum (see `RoadmapSafetyStatus`'s doc) — validated against its runtime
  // companion const array.
  @IsOptional()
  @IsIn(ROADMAP_SAFETY_STATUSES)
  safetyStatus?: RoadmapSafetyStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  blockedBy?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  blockedWhy?: string | null;

  @IsOptional()
  @IsEnum(RoadmapPaidKind)
  paidKind?: RoadmapPaidKind;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  weeklyHours?: number;

  @IsOptional()
  @IsEnum(RoadmapCost)
  cost?: RoadmapCost;

  // Null when unassigned.
  @IsOptional()
  @IsUUID()
  ownerId?: string | null;

  // Present only for resource/how-to items; `null` clears it.
  @IsOptional()
  @ValidateNested()
  @Type(() => RoadmapGuideDto)
  guide?: RoadmapGuideDto | null;

  // Planned only. Starting seed count; member votes accrue on top.
  @IsOptional()
  @IsInt()
  @Min(0)
  votes?: number;

  // Planned only — flags the "🔥 Hot" badge.
  @IsOptional()
  @IsBoolean()
  hot?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
