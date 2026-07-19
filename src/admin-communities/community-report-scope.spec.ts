import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { summariseReportsByCommunity } from './community-report-scope';

const NOW = new Date('2026-07-19T12:00:00.000Z');
const YESTERDAY = new Date('2026-07-18T12:00:00.000Z');
const TOMORROW = new Date('2026-07-20T12:00:00.000Z');

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    subjectType: ReportSubjectType.Community,
    subjectId: 'trans-friends',
    reasonCode: 'harassment',
    detail: null,
    anonymous: false,
    contactEmail: null,
    evidence: null,
    severity: ReportSeverity.Medium,
    slaDueAt: TOMORROW,
    status: ReportStatus.Open,
    reporterId: 'user-1',
    createdAt: YESTERDAY,
    ...overrides,
  };
}

const SLUG_TO_COMMUNITY_ID = new Map([['trans-friends', 'community-1']]);

describe('summariseReportsByCommunity', () => {
  it('attributes a community-subject report by matching its slug', () => {
    const totals = summariseReportsByCommunity(
      [makeReport()],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.totalReportCount).toBe(1);
    expect(totals.get('community-1')?.openReportCount).toBe(1);
  });

  it('attributes a post report through the post-to-community lookup', () => {
    // Content reports carry the post id in subjectId, not a community slug —
    // the service resolves post ids to communities and passes that map in.
    const totals = summariseReportsByCommunity(
      [
        makeReport({
          id: 'report-2',
          subjectType: ReportSubjectType.Post,
          subjectId: 'post-9',
        }),
      ],
      new Map([['post-9', 'community-1']]),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.totalReportCount).toBe(1);
  });

  it('attributes a reply report through the same post/reply-to-community lookup', () => {
    // A reply id is not a post id — they live in different tables — but both
    // are resolved through the same communityIdBySubjectId map. This guards
    // the contract that Task 3 must populate that map from BOTH tables.
    const totals = summariseReportsByCommunity(
      [
        makeReport({
          id: 'report-3',
          subjectType: ReportSubjectType.Reply,
          subjectId: 'reply-7',
        }),
      ],
      new Map([['reply-7', 'community-1']]),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.totalReportCount).toBe(1);
  });

  it('drops a report whose subject belongs to no known community', () => {
    // A venue or DM report has no community. Attributing it anywhere would
    // silently blame an unrelated space for someone else's incident.
    const totals = summariseReportsByCommunity(
      [
        makeReport({
          subjectType: ReportSubjectType.Venue,
          subjectId: 'venue-3',
        }),
      ],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.size).toBe(0);
  });

  it('counts resolved and escalated reports in the total but not as open', () => {
    const totals = summariseReportsByCommunity(
      [
        makeReport({ id: 'a', status: ReportStatus.Resolved }),
        makeReport({ id: 'b', status: ReportStatus.Escalated }),
        makeReport({ id: 'c', status: ReportStatus.Open }),
      ],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.totalReportCount).toBe(3);
    expect(totals.get('community-1')?.openReportCount).toBe(1);
  });

  it('counts an open report past its SLA as overdue', () => {
    const totals = summariseReportsByCommunity(
      [makeReport({ slaDueAt: YESTERDAY, status: ReportStatus.Open })],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.overdueOpenReportCount).toBe(1);
  });

  it('does not count a resolved report as overdue even when its SLA passed', () => {
    const totals = summariseReportsByCommunity(
      [makeReport({ slaDueAt: YESTERDAY, status: ReportStatus.Resolved })],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.overdueOpenReportCount).toBe(0);
  });

  it('weights open reports by severity so one emergency outweighs several low ones', () => {
    const emergencyTotals = summariseReportsByCommunity(
      [makeReport({ severity: ReportSeverity.Emergency })],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    const lowSeverityTotals = summariseReportsByCommunity(
      [
        makeReport({ id: 'a', severity: ReportSeverity.Low }),
        makeReport({ id: 'b', severity: ReportSeverity.Low }),
      ],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(
      emergencyTotals.get('community-1')?.severityWeightedOpenLoad,
    ).toBeGreaterThan(
      lowSeverityTotals.get('community-1')?.severityWeightedOpenLoad ?? 0,
    );
  });

  it('excludes closed reports from the weighted open load', () => {
    const totals = summariseReportsByCommunity(
      [
        makeReport({
          severity: ReportSeverity.Emergency,
          status: ReportStatus.Resolved,
        }),
      ],
      new Map(),
      SLUG_TO_COMMUNITY_ID,
      NOW,
    );
    expect(totals.get('community-1')?.severityWeightedOpenLoad).toBe(0);
  });
});
