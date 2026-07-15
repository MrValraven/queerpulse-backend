import { Company } from '../companies/entities/company.entity';
import { Affiliation } from './entities/affiliation.entity';

// Matches the LIVE frontend caller
// `queerpulse/src/features/economy/api/affiliation.api.ts` exactly (ground
// truth — `contracts.ts` does not declare this shape, so it is not consulted
// here).

export interface EmployerAffiliationDTO {
  companySlug: string;
  company: { nameText: string };
  role: string;
  status: 'pending' | 'active';
}

export function toEmployerAffiliationDTO(
  affiliation: Affiliation,
  company: Pick<Company, 'slug' | 'nameText'>,
): EmployerAffiliationDTO {
  return {
    companySlug: company.slug,
    company: { nameText: company.nameText },
    role: affiliation.role,
    status: affiliation.status,
  };
}
