import { ReportSeverity } from './entities/report.entity';
import { ReasonCode } from './reason-catalogue';

/**
 * Server-derived severity classification. The frontend never sends severity
 * (`reports.api.ts`'s `CreateReportInput` has no such field — "Severity + SLA
 * are derived server-side" per its `ReportDTO` doc comment); this is the one
 * place that mapping lives.
 */
const EMERGENCY_REASONS: ReadonlySet<ReasonCode> = new Set([
  'outing',
  'doxxing',
]);

const HIGH_REASONS: ReadonlySet<ReasonCode> = new Set([
  'harassment',
  'unwanted_contact',
  'venue_safety',
]);

const MEDIUM_REASONS: ReadonlySet<ReasonCode> = new Set([
  'hate_speech',
  'discrimination',
  'impersonation',
  'venue_staff',
  'venue_accessibility',
]);

export function deriveSeverity(reasonCode: ReasonCode): ReportSeverity {
  if (EMERGENCY_REASONS.has(reasonCode)) return ReportSeverity.Emergency;
  if (HIGH_REASONS.has(reasonCode)) return ReportSeverity.High;
  if (MEDIUM_REASONS.has(reasonCode)) return ReportSeverity.Medium;
  return ReportSeverity.Low;
}

const SLA_WINDOW_MS: Record<ReportSeverity, number> = {
  [ReportSeverity.Emergency]: 60 * 60 * 1000, // 1h
  [ReportSeverity.High]: 24 * 60 * 60 * 1000, // 24h
  [ReportSeverity.Medium]: 3 * 24 * 60 * 60 * 1000, // 3d
  [ReportSeverity.Low]: 7 * 24 * 60 * 60 * 1000, // 7d
};

export function slaDueAtFor(severity: ReportSeverity, from: Date): Date {
  return new Date(from.getTime() + SLA_WINDOW_MS[severity]);
}

const ACKNOWLEDGEMENTS: Record<ReportSeverity, string> = {
  [ReportSeverity.Emergency]:
    "We've flagged this as urgent and prioritized it for immediate review.",
  [ReportSeverity.High]:
    'This has been flagged as high priority — our team will review it within 24 hours.',
  [ReportSeverity.Medium]:
    'Thanks for the report. Our moderation team will review it soon.',
  [ReportSeverity.Low]:
    'Thanks for the report. Our moderation team will review it soon.',
};

export function acknowledgementFor(severity: ReportSeverity): string {
  return ACKNOWLEDGEMENTS[severity];
}
