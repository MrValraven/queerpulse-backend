import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum RoadmapColumn {
  Backlog = 'backlog',
  Planned = 'planned',
  Building = 'building',
  Shipped = 'shipped',
}

/** How urgently the team intends to pick a card up. */
export enum RoadmapPriority {
  P0 = 'P0',
  P1 = 'P1',
  P2 = 'P2',
  P3 = 'P3',
}

/** How sure the team is the card ships as scoped. */
export enum RoadmapConfidence {
  Likely = 'likely',
  Maybe = 'maybe',
  Hoping = 'hoping',
}

/** Whether the work is done by a paid contributor or a volunteer. */
export enum RoadmapPaidKind {
  Paid = 'paid',
  Volunteer = 'volunteer',
}

/** Rough funding bucket for the card. */
export enum RoadmapCost {
  None = 'none',
  Small = 'small',
  Funded = 'funded',
  Needs = 'needs',
}

/**
 * `0 | 1 | 2` — none / required / cleared. Stored as `smallint`; not a
 * Postgres enum since the admin UI treats it as an ordered tri-state, not a
 * closed label set. The const array is the runtime companion the DTOs
 * `@IsIn()` against (Task A3) — deriving the type from it keeps one source
 * of truth instead of a separately-typed literal union.
 */
export const ROADMAP_SAFETY_STATUSES = [0, 1, 2] as const;
export type RoadmapSafetyStatus = (typeof ROADMAP_SAFETY_STATUSES)[number];

/**
 * The six checklist steps rendered in a resource item's "guide" section. See
 * `RoadmapSafetyStatus` above for why this pairs a const array with a
 * derived type rather than a Postgres/TS `enum`.
 */
export const ROADMAP_GUIDE_STEPS = [
  'research',
  'draft',
  'lived',
  'expert',
  'translate',
  'publish',
] as const;
export type RoadmapGuideStep = (typeof ROADMAP_GUIDE_STEPS)[number];

/** One entry in `RoadmapItem.slips` — a target-date move with a reason. */
export interface RoadmapSlipEntry {
  from: string;
  to: string;
  reason: string;
  movedByName: string;
  movedAt: string;
}

/** Shape of `RoadmapItem.guide` for resource/how-to items. */
export interface RoadmapGuide {
  steps: Record<RoadmapGuideStep, boolean>;
  reviewer: string;
  credential: string;
  reVerifyBy: string | null;
  languages: { en: boolean; pt: boolean; br: boolean };
}

/**
 * One roadmap card — backlog, planned, building, or shipped — backing
 * `GET /roadmap` (public) and `GET /admin/roadmap` (the full admin board).
 * Mirrors the frontend's `AdminRoadmapItemDTO` in
 * `queerpulse/src/features/admin/api/roadmapAdmin.api.ts`; the public-facing
 * subset mirrors `ShippedItem`/`BuildingItem`/`PlannedItem` in
 * `queerpulse/src/features/marketing/roadmap.data.ts`. `description` holds
 * internal notes; `publicNote` holds the warm one-liner shown to members.
 * `ownerId` is a plain FK-less column — no eager relation — because the
 * admin service resolves `ownerName` from `users` in one batch query per
 * `GET /admin/roadmap` call rather than joining per row.
 */
@Entity('roadmap_items')
@Index('IDX_roadmap_items_column_sort', ['column', 'sortOrder'])
export class RoadmapItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: RoadmapColumn })
  column!: RoadmapColumn;

  @Column()
  category!: string;

  @Column()
  name!: string;

  // Internal notes, not shown to members.
  @Column({ type: 'text' })
  description!: string;

  // The warm one-liner shown on the public roadmap.
  @Column({ type: 'varchar', nullable: true })
  publicNote!: string | null;

  // Shipped only, e.g. "May 2026".
  @Column({ type: 'varchar', nullable: true })
  date!: string | null;

  // Building only, e.g. "In progress".
  @Column({ type: 'varchar', nullable: true })
  stage!: string | null;

  // Building only, e.g. "~Q3 2026".
  @Column({ type: 'varchar', nullable: true })
  eta!: string | null;

  // e.g. "Q3 2026" — the quarter this card is committed to ship in. Changing
  // it on a non-shipped item requires a `slips` entry (enforced in the
  // admin service, not here).
  @Column({ type: 'varchar', nullable: true })
  targetQuarter!: string | null;

  // Building only, 0-100.
  @Column({ type: 'int', nullable: true })
  progress!: number | null;

  @Column({
    type: 'enum',
    enum: RoadmapPriority,
    default: RoadmapPriority.P2,
  })
  priority!: RoadmapPriority;

  @Column({
    type: 'enum',
    enum: RoadmapConfidence,
    default: RoadmapConfidence.Maybe,
  })
  confidence!: RoadmapConfidence;

  // A "promise" badge — publicly stated as committed, not just planned.
  @Column({ default: false })
  committed!: boolean;

  // Whether this card surfaces on the public `/about/roadmap` page at all.
  @Column({ default: true })
  isPublic!: boolean;

  // Seeded/backlog-origin flag: at least one member asked for this.
  @Column({ default: false })
  requested!: boolean;

  // Whether voters were already notified this card moved/shipped.
  @Column({ default: false })
  notified!: boolean;

  // Flags a card as a spike/investigation rather than committed scope.
  @Column({ default: false })
  spikeFlag!: boolean;

  // 0 = none, 1 = required, 2 = cleared. Gates `isPublic` while `1`.
  @Column({ type: 'smallint', default: 0 })
  safetyStatus!: RoadmapSafetyStatus;

  // Free-text pointer to what's blocking this card (may reference another
  // item by name/id informally — no FK, matches how `roadmap_item_dependencies`
  // models the strict form of this relationship).
  @Column({ type: 'varchar', nullable: true })
  blockedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  blockedWhy!: string | null;

  @Column({
    type: 'enum',
    enum: RoadmapPaidKind,
    default: RoadmapPaidKind.Volunteer,
  })
  paidKind!: RoadmapPaidKind;

  @Column({ type: 'int', default: 0 })
  weeklyHours!: number;

  @Column({ type: 'enum', enum: RoadmapCost, default: RoadmapCost.None })
  cost!: RoadmapCost;

  // Null when unassigned. No relation — see class doc.
  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  // Target-date move history; each entry requires a `reason` (see
  // `RoadmapItemWriteBody.slipReason` in the admin service).
  @Column({ type: 'jsonb', default: () => "'[]'" })
  slips!: RoadmapSlipEntry[];

  // Present only for resource/how-to items; null otherwise.
  @Column({ type: 'jsonb', nullable: true })
  guide!: RoadmapGuide | null;

  // Planned/backlog only. Starting seed count; member votes accrue on top
  // via `roadmap_votes`.
  @Column({ type: 'int', default: 0 })
  votes!: number;

  // Planned only — flags the "🔥 Hot" badge.
  @Column({ default: false })
  hot!: boolean;

  // Hidden from every view except the Archive view.
  @Column({ default: false })
  archived!: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
