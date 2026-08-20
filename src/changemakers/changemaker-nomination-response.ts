import { ChangemakerNomination } from './entities/changemaker-nomination.entity';

/** Shape returned by `POST /changemakers/nominations` — just enough for the
 * frontend's toast to confirm what was sent. */
export interface ChangemakerNominationResponseDTO {
  id: string;
  nomineeName: string;
  reason: string | null;
  createdAt: string;
}

export function toChangemakerNominationResponse(
  entity: ChangemakerNomination,
): ChangemakerNominationResponseDTO {
  return {
    id: entity.id,
    nomineeName: entity.nomineeName,
    reason: entity.reason,
    createdAt: entity.createdAt.toISOString(),
  };
}
