/**
 * Shape the admin overview dashboard renders. Pure DTO + mapper helpers only
 * — no DB access, no Nest decorators — so the stacking/bucketing/aggregation
 * math here stays directly unit-testable, mirroring
 * `../admin-communities/admin-communities-response.ts` and
 * `../admin-members/admin-members-response.ts`.
 */
export interface AdminOverviewDTO {
  stats: {
    activeMembers: {
      value: number;
      growthPercent: number | null;
      netNewThisWeek: number;
    };
    openReports: {
      value: number;
      oldestOpenHours: number | null;
      emergencies: number;
    };
    medianResponseHours: number | null;
    sustainerMrr: number | null;
    sustainerCount: number | null;
    verifiedMembers: number;
  };
  triage: {
    emergencies: number;
    openReports: number;
    pendingVerifications: number;
    openAppeals: number;
  };
  reportsByType: {
    weeks: { weekStart: string; values: [number, number, number, number] }[];
  };
  memberGrowth: {
    points: {
      at: string;
      joined: number;
      churned: number | null;
      spike: boolean;
    }[];
  };
  responseTime: {
    medianHours: number | null;
    buckets: { label: string; value: number; overSla: boolean }[];
  } | null;
  feed: {
    id: string;
    type: string;
    actor: string | null;
    target: string | null;
    community: string | null;
    count: number | null;
    at: string;
    route: string;
  }[];
}

// Which of the four `reportsByType.values` slots a reason code stacks into.
// Slot 3 ("Other") is a catch-all over the real `Report.reasonCode`
// vocabulary (`../reports/reason-catalogue.ts`: `outing | doxxing |
// harassment | hate_speech | unwanted_contact | impersonation |
// discrimination | spam | off_topic | venue_safety | venue_staff |
// venue_accessibility | other`) — every real code besides `outing`,
// `harassment`, and `spam` (doxxing, hate_speech, unwanted_contact,
// impersonation, discrimination, off_topic, the venue_* codes, and the
// literal `other` code itself) aggregates into slot 3.
const CATEGORY_INDEX: Record<string, 0 | 1 | 2> = {
  outing: 0,
  harassment: 1,
  spam: 2,
};

export function reasonCodeToCategoryIndex(reasonCode: string): 0 | 1 | 2 | 3 {
  return CATEGORY_INDEX[reasonCode] ?? 3; // 3 = "Other": all remaining real reason codes
}

/** Middle value of a sorted copy of `hoursDeltas` (average of the two
 *  middle values when the count is even). Null for an empty set — there is
 *  no median of nothing. */
export function medianHours(hoursDeltas: number[]): number | null {
  if (hoursDeltas.length === 0) return null;

  const sortedHoursDeltas = [...hoursDeltas].sort(
    (firstHours, secondHours) => firstHours - secondHours,
  );
  const middleIndex = Math.floor(sortedHoursDeltas.length / 2);

  if (sortedHoursDeltas.length % 2 === 1) {
    return sortedHoursDeltas[middleIndex];
  }
  return (
    (sortedHoursDeltas[middleIndex - 1] + sortedHoursDeltas[middleIndex]) / 2
  );
}

/** Response-time SLA, in hours. A report answered at or after this point
 *  counts as over-SLA. */
export const RESPONSE_TIME_SLA_HOURS = 6;

interface ResponseTimeBucketDefinition {
  label: string;
  test: (hoursDelta: number) => boolean;
  overSla: boolean;
}

const RESPONSE_TIME_BUCKET_DEFINITIONS: ResponseTimeBucketDefinition[] = [
  { label: '<1h', test: (hoursDelta) => hoursDelta < 1, overSla: false },
  {
    label: '1–2h',
    test: (hoursDelta) => hoursDelta >= 1 && hoursDelta < 2,
    overSla: false,
  },
  {
    label: '2–4h',
    test: (hoursDelta) => hoursDelta >= 2 && hoursDelta < 4,
    overSla: false,
  },
  {
    label: '4–6h',
    test: (hoursDelta) => hoursDelta >= 4 && hoursDelta < 6,
    overSla: false,
  },
  {
    label: '6–8h',
    test: (hoursDelta) => hoursDelta >= 6 && hoursDelta < 8,
    overSla: true,
  },
  { label: '8h+', test: (hoursDelta) => hoursDelta >= 8, overSla: true },
];

/** Bins report-response deltas (in hours) into six fixed buckets, flagging
 *  the two buckets at/after `RESPONSE_TIME_SLA_HOURS` as over-SLA. */
export function bucketResponseTimes(
  hoursDeltas: number[],
): { label: string; value: number; overSla: boolean }[] {
  return RESPONSE_TIME_BUCKET_DEFINITIONS.map((bucketDefinition) => ({
    label: bucketDefinition.label,
    value: hoursDeltas.filter((hoursDelta) => bucketDefinition.test(hoursDelta))
      .length,
    overSla: bucketDefinition.overSla,
  }));
}
