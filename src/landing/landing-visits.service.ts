import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LandingVisitDaily } from './entities/landing-visit-daily.entity';
import { normalizeLandingSource } from './landing-visit-source';

/** The admin panel ranges, in whole UTC days. */
export const LANDING_VISIT_RANGE_DAYS = [30, 90] as const;
export type LandingVisitRangeDays = (typeof LANDING_VISIT_RANGE_DAYS)[number];

const TOP_SOURCE_LIMIT = 10;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * User agents that announce a crawler, a link unfurler, an audit tool or a
 * script. A request with no user agent at all counts as one too.
 */
const BOT_USER_AGENT_PATTERN =
  /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|curl|wget|python|httpclient/i;

export interface AdminLandingVisitsDTO {
  rangeDays: LandingVisitRangeDays;
  total: number;
  /** Zero-filled, oldest first, UTC, exactly `rangeDays` entries ending today. */
  days: { day: string; visits: number }[];
  /** At most ten, most visits first. */
  topSources: { source: string; visits: number }[];
}

function toUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isBotUserAgent(userAgent: string | undefined): boolean {
  if (typeof userAgent !== 'string' || userAgent.trim().length === 0) {
    return true;
  }
  return BOT_USER_AGENT_PATTERN.test(userAgent);
}

/**
 * A JSON body is what forces the browser to send a CORS preflight, so only a
 * JSON request has passed the origin allowlist. A `text/plain` or form POST is
 * a CORS simple request that any site can fire straight at the beacon.
 */
export function isJsonContentType(contentType: string | undefined): boolean {
  return (
    typeof contentType === 'string' &&
    contentType.trim().toLowerCase().startsWith('application/json')
  );
}

/**
 * Anonymous landing page visit counts.
 *
 * `record` bumps one (day, source) counter. The user agent is read only to
 * skip bots: it is never stored, logged or passed anywhere else. A request
 * without a JSON content type writes nothing (see `isJsonContentType`).
 */
@Injectable()
export class LandingVisitsService {
  constructor(
    @InjectRepository(LandingVisitDaily)
    private readonly landingVisits: Repository<LandingVisitDaily>,
  ) {}

  async record(
    rawSource: string | undefined,
    userAgent: string | undefined,
    contentType: string | undefined,
  ): Promise<void> {
    if (!isJsonContentType(contentType) || isBotUserAgent(userAgent)) {
      return;
    }
    const day = toUtcDay(new Date());
    const source = normalizeLandingSource(rawSource);
    await this.landingVisits.query(
      `INSERT INTO "landing_visit_daily" ("day", "source", "visits")
       VALUES ($1, $2, 1)
       ON CONFLICT ("day", "source")
       DO UPDATE SET "visits" = "landing_visit_daily"."visits" + 1`,
      [day, source],
    );
  }

  /**
   * The last `rangeDays` UTC days, today included. Days with no row come back
   * as zero so the chart always has exactly `rangeDays` points.
   */
  async getStats(
    rangeDays: LandingVisitRangeDays,
  ): Promise<AdminLandingVisitsDTO> {
    const now = new Date();
    const todayStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
    );
    const orderedDays: string[] = [];
    for (let dayOffset = rangeDays - 1; dayOffset >= 0; dayOffset -= 1) {
      orderedDays.push(
        toUtcDay(new Date(todayStart - dayOffset * MILLISECONDS_PER_DAY)),
      );
    }
    const rangeStartDay = orderedDays[0];

    const dailyRows: { day: string; visits: string | number }[] =
      await this.landingVisits.query(
        `SELECT to_char("day", 'YYYY-MM-DD') AS "day", SUM("visits") AS "visits"
         FROM "landing_visit_daily"
         WHERE "day" >= $1
         GROUP BY "day"`,
        [rangeStartDay],
      );
    const sourceRows: { source: string; visits: string | number }[] =
      await this.landingVisits.query(
        `SELECT "source", SUM("visits") AS "visits"
         FROM "landing_visit_daily"
         WHERE "day" >= $1
         GROUP BY "source"
         ORDER BY SUM("visits") DESC, "source" ASC
         LIMIT $2`,
        [rangeStartDay, TOP_SOURCE_LIMIT],
      );

    const visitsByDay = new Map<string, number>();
    for (const row of dailyRows) {
      visitsByDay.set(row.day, Number(row.visits));
    }
    const days = orderedDays.map((day) => ({
      day,
      visits: visitsByDay.get(day) ?? 0,
    }));
    const total = days.reduce((runningTotal, entry) => {
      return runningTotal + entry.visits;
    }, 0);
    const topSources = sourceRows.map((row) => ({
      source: row.source,
      visits: Number(row.visits),
    }));

    return { rangeDays, total, days, topSources };
  }
}
