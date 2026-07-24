import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One curated health stat tile, e.g. `{ key: "activeMembers", n: "247", up:
 * true, trendKey: "upThisQuarter", trendCount: 38 }`. Mirrors the frontend's
 * `HEALTH` shape in `queerpulse/src/features/governance/governance.data.ts` —
 * but structure-only: `key`/`trendKey` are i18n keys the frontend resolves to
 * EN/PT strings, so no prose lives here. `trendCount` is the optional
 * interpolation value for trends that carry one ("↑ 38 this quarter").
 */
export interface OverviewHealthStat {
  key: string;
  n: string;
  up: boolean;
  trendKey: string;
  trendCount?: number;
}

/** One moderation-process step, keyed for i18n. Order is array order. */
export interface OverviewModerationStep {
  key: string;
}

/**
 * One advisory-council seat. `name`/`initials` are non-translatable data the
 * backend owns; `roleKey` is the seat descriptor resolved to EN/PT on the
 * frontend; `tint` selects the avatar colour pair (`jade`/`violet`/`plum`) the
 * frontend maps to `{bg,color}`.
 */
export interface OverviewCouncilSeat {
  name: string;
  initials: string;
  roleKey: string;
  tint: 'jade' | 'violet' | 'plum';
}

/**
 * One platform principle. `key` is the i18n key (title + text); `icon` selects
 * the react-icon the frontend maps (`lock`/`eye`/`slash`/`message`/`book`/
 * `accessible`). Order is array order.
 */
export interface OverviewPrinciple {
  key: string;
  icon: string;
}

/** One decision-log entry, keyed for i18n (lead + body). Order is array order. */
export interface OverviewDecision {
  key: string;
}

/** The singleton id — this table always holds exactly one row (see below). */
export const GOVERNANCE_OVERVIEW_ID = 'current';

/**
 * The non-financial structure of the Governance page (`/about/governance`):
 * the health snapshot, moderation-process rail, advisory council, platform
 * principles, and decision log. Backs `GET /governance/overview`, read by
 * `GovernanceSections.tsx`.
 *
 * Read-only + seeded (mirrors `governance_finance_report` and the `resources`
 * module): there is no authoring endpoint, only a seeded snapshot a maintainer
 * would insert/edit. Stored as one `jsonb` document keyed on a fixed id
 * (`GOVERNANCE_OVERVIEW_ID`) — a **singleton**, like
 * `changemaker_directory_settings` — because the whole page renders as one
 * cohesive published document with no independent per-row query needs.
 *
 * "Structure in the DB, words in i18n": every field here is a stable content
 * key, a number, or non-translatable data (names/initials). The translated
 * prose stays in the frontend i18n catalogs, so EN/PT is preserved.
 */
@Entity('governance_overview')
export class GovernanceOverview {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id: string;

  @Column({ type: 'jsonb' })
  health: OverviewHealthStat[];

  @Column({ type: 'jsonb', name: 'moderation_steps' })
  moderationSteps: OverviewModerationStep[];

  @Column({ type: 'jsonb' })
  council: OverviewCouncilSeat[];

  @Column({ type: 'jsonb' })
  principles: OverviewPrinciple[];

  @Column({ type: 'jsonb' })
  decisions: OverviewDecision[];

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
