import { MemberRef } from '../common/member-ref';
import {
  ResourceSuggestion,
  ResourceSuggestionStatus,
} from './entities/resource-suggestion.entity';

/** Shape returned by `POST /resources/suggestions` — just enough for the
 *  frontend's success state to confirm what was sent. */
export interface ResourceSuggestionResponseDTO {
  id: string;
  category: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  createdAt: string;
}

export function toResourceSuggestionResponse(
  suggestion: ResourceSuggestion,
): ResourceSuggestionResponseDTO {
  return {
    id: suggestion.id,
    category: suggestion.category,
    name: suggestion.name,
    description: suggestion.description,
    phone: suggestion.phone,
    email: suggestion.email,
    website: suggestion.website,
    createdAt: suggestion.createdAt.toISOString(),
  };
}

export interface AdminPersonDTO {
  slug: string;
  name: string;
  avatarUrl: string | null;
}

export function toAdminPerson(ref: MemberRef | null): AdminPersonDTO | null {
  if (!ref) return null;
  return {
    slug: ref.slug,
    name: `${ref.firstName} ${ref.lastName}`.trim(),
    avatarUrl: ref.avatarUrl,
  };
}

/** One resource-suggestion row on the admin review queue. `decidedBy` is
 *  deliberately NOT exposed — mirrors `AdminReadingGroupProposalDTO`. */
export interface AdminResourceSuggestionDTO {
  id: string;
  member: AdminPersonDTO | null;
  category: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  createdAt: string;
  status: ResourceSuggestionStatus;
  decidedAt: string | null;
  decisionNote: string | null;
}

export interface AdminResourceSuggestionsPageDTO {
  items: AdminResourceSuggestionDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export function toAdminResourceSuggestionDTO(
  suggestion: ResourceSuggestion,
  member: MemberRef | null,
): AdminResourceSuggestionDTO {
  return {
    id: suggestion.id,
    member: toAdminPerson(member),
    category: suggestion.category,
    name: suggestion.name,
    description: suggestion.description,
    phone: suggestion.phone,
    email: suggestion.email,
    website: suggestion.website,
    createdAt: suggestion.createdAt.toISOString(),
    status: suggestion.status,
    decidedAt: suggestion.decidedAt ? suggestion.decidedAt.toISOString() : null,
    decisionNote: suggestion.decisionNote,
  };
}
