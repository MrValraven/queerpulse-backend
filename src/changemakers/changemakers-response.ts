import { Changemaker } from './entities/changemaker.entity';

export interface ChangemakerDTO {
  id: string;
  slug: string;
  name: string;
  initials: string;
  cause: string;
  tint: 'coral' | 'jade' | 'plum';
  tags: string[];
  summary: string;
  imageUrl: string | null;
  impact: string[];
  byline: string;
  heroNote: string;
  lead: string;
  body: string[];
  pullQuoteText: string;
  pullQuoteCite: string;
  status: 'draft' | 'published';
  isFeatured: boolean;
  sortOrder: number;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DirectoryStatsDTO {
  profiled: number;
  causeAreas: number;
  peopleHelped: number;
  activeCampaigns: number;
}

export interface ChangemakerListResponseDTO {
  profiles: ChangemakerDTO[];
  stats: DirectoryStatsDTO;
}

export function toChangemakerDTO(entity: Changemaker): ChangemakerDTO {
  return {
    id: entity.id,
    slug: entity.slug,
    name: entity.name,
    initials: entity.initials,
    cause: entity.cause,
    tint: entity.tint,
    tags: entity.tags ?? [],
    summary: entity.summary,
    imageUrl: entity.imageUrl,
    impact: entity.impact ?? [],
    byline: entity.byline,
    heroNote: entity.heroNote,
    lead: entity.lead,
    body: entity.body ?? [],
    pullQuoteText: entity.pullQuoteText,
    pullQuoteCite: entity.pullQuoteCite,
    status: entity.status,
    isFeatured: entity.isFeatured,
    sortOrder: entity.sortOrder,
    publishedAt: entity.publishedAt ? entity.publishedAt.toISOString() : null,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export function toDirectoryStatsDTO(
  publishedProfiles: Changemaker[],
  peopleHelped: number,
  activeCampaigns: number,
): DirectoryStatsDTO {
  const causeAreas = new Set(
    publishedProfiles.map((profile) => profile.cause.trim().toLowerCase()),
  );
  return {
    profiled: publishedProfiles.length,
    causeAreas: causeAreas.size,
    peopleHelped,
    activeCampaigns,
  };
}
