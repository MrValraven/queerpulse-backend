import {
  ReadingGroupProposal,
  ReadingGroupProposalFormat,
} from './entities/reading-group-proposal.entity';

/** Shape returned by `POST /reading-groups/proposals` — just enough for the
 * frontend's success panel to confirm what was sent (the group directory
 * itself is curated editorial content, so this isn't a re-fetch/list shape). */
export interface ReadingGroupProposalResponseDTO {
  id: string;
  book: string;
  why: string | null;
  format: ReadingGroupProposalFormat;
  maxPeople: number;
  createdAt: string;
}

export function toReadingGroupProposalResponse(
  entity: ReadingGroupProposal,
): ReadingGroupProposalResponseDTO {
  return {
    id: entity.id,
    book: entity.book,
    why: entity.why,
    format: entity.format,
    maxPeople: entity.maxPeople,
    createdAt: entity.createdAt.toISOString(),
  };
}
