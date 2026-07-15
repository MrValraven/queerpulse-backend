import { ConsentAction, ConsentRecord } from './entities/consent-record.entity';

// Matches the LIVE frontend caller `queerpulse/src/shared/api/consent.api.ts`
// (the ground-truth wire contract — it declares these inline and does not use
// the stale `contracts.ts` ConsentResponse).

export interface ConsentCategories {
  necessary: true;
  analytics: boolean;
  monitoring: boolean;
}

export interface ConsentRecordDTO {
  categories: ConsentCategories;
  policyVersion: string;
  action: ConsentAction;
  createdAt: string;
}

export interface MyConsentResponse {
  categories: ConsentCategories;
  policyVersion: string;
}

// `necessary` is always on and never persisted — re-synthesised here.
export function toCategories(record: {
  analytics: boolean;
  monitoring: boolean;
}): ConsentCategories {
  return {
    necessary: true,
    analytics: record.analytics,
    monitoring: record.monitoring,
  };
}

export function toConsentRecordDTO(record: ConsentRecord): ConsentRecordDTO {
  return {
    categories: toCategories(record),
    policyVersion: record.policyVersion,
    action: record.action,
    createdAt: record.createdAt.toISOString(),
  };
}

export function toMyConsentResponse(record: ConsentRecord): MyConsentResponse {
  return {
    categories: toCategories(record),
    policyVersion: record.policyVersion,
  };
}
