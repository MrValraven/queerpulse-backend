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
 * PRD-265. One piece of prose an EDITOR wrote, in both languages.
 *
 * The four decisions, six principles and four council roles this table shipped
 * with are i18n KEYS: their EN and PT live in the frontend catalogs, and adding
 * a fifth decision meant a code change and a deploy. That made the public
 * decision log — the page the platform presents as its accountability record —
 * a bundle constant, so the next real decision could not be logged by the
 * people who took it.
 *
 * An authored entry carries its own words instead. There is no key to
 * translate, so the editor supplies both languages at write time; the reader
 * picks the one for the active language. Stored sanitised (see
 * `GovernanceOverviewService.toStoredAuthoredText`), so the public page never
 * strips markup at render.
 */
export interface OverviewAuthoredText {
  en: string;
  pt: string;
}

/**
 * One advisory-council seat.
 *
 * A seat NAMES A MEMBER rather than carrying typed-in words: `memberId` is the
 * user id of someone on the platform staff roster, and the person's name and
 * face are resolved from their profile at read time
 * (`GovernanceOverviewService.toCouncilSeatResponses`). Before this, a seat was
 * a free-text `name` + `initials` pair, which meant the platform's public
 * accountability page could name anyone at all, and went stale the moment a
 * seat-holder changed their name.
 *
 * `tint` selects the avatar colour pair (`jade`/`violet`/`plum`) the frontend
 * maps to `{bg,color}` for the monogram it falls back to when the member shows
 * no photo — presentation the seat owns, so it stays here.
 *
 * The seat descriptor comes from EXACTLY ONE of two places (PRD-265):
 * `roleKey`, an i18n key resolved on the frontend, on the four seeded seats;
 * or `role`, the editor's own EN/PT words, on a seat authored in the admin UI.
 * Both fields are optional on the type and the DTO enforces the exclusive-or,
 * so a seeded role keeps rendering unchanged and a new one needs no deploy.
 */
export interface OverviewCouncilSeat {
  /** The seat-holder's user id. Must be on the staff roster at write time. */
  memberId: string;
  roleKey?: string;
  role?: OverviewAuthoredText;
  tint: 'jade' | 'violet' | 'plum';
}

/**
 * One platform principle. `icon` selects the react-icon the frontend maps
 * (`lock`/`eye`/`slash`/`message`/`book`/`accessible`). Order is array order.
 *
 * `key` (i18n, seeded) or `title` + `text` (authored, PRD-265) — exactly one
 * of the two forms, enforced by the DTO.
 */
export interface OverviewPrinciple {
  key?: string;
  title?: OverviewAuthoredText;
  text?: OverviewAuthoredText;
  icon: string;
}

/**
 * One decision-log entry. Order is array order.
 *
 * `key` (i18n, seeded) or `lead` + `body` (authored, PRD-265) — exactly one of
 * the two forms, enforced by the DTO.
 */
export interface OverviewDecision {
  key?: string;
  lead?: OverviewAuthoredText;
  body?: OverviewAuthoredText;
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
 * "Structure in the DB, words in i18n" was the original rule: every field was
 * a stable content key, a number, or non-translatable data (names/initials).
 * That rule still holds for the SEEDED entries, and their translated prose
 * still lives in the frontend catalogs.
 *
 * PRD-265 adds a second, coexisting form: a decision, principle or council
 * seat an editor AUTHORED, carrying its own EN and PT text
 * ({@link OverviewAuthoredText}) because no key exists to translate. The rule
 * it replaces was making the platform's accountability record un-growable —
 * logging the next real decision required a deploy. Both forms live in the
 * same array; the reader resolves whichever one an entry carries.
 */
@Entity('governance_overview')
export class GovernanceOverview {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id!: string;

  @Column({ type: 'jsonb' })
  health!: OverviewHealthStat[];

  @Column({ type: 'jsonb' })
  moderationSteps!: OverviewModerationStep[];

  @Column({ type: 'jsonb' })
  council!: OverviewCouncilSeat[];

  @Column({ type: 'jsonb' })
  principles!: OverviewPrinciple[];

  @Column({ type: 'jsonb' })
  decisions!: OverviewDecision[];

  /**
   * When an admin/moderator last **published** this snapshot (P3-7). `null`
   * until the first publish. Distinct from `updatedAt` (which bumps on any
   * write): publishing is the deliberate "this is now the transparency report
   * members can rely on" act, so the public `GET /governance/overview` response
   * carries this timestamp for a "last published" line.
   */
  @Column({ type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
