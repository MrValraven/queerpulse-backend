import { ContentPage } from './entities/content-page.entity';

/**
 * Mirrors `PageResponse` in
 * `queerpulse/src/shared/contracts/contracts.ts` exactly (Content/CMS
 * section) — field-for-field, so this module's routes can be wired to the
 * `culture`/`support`/`governance` features with no shape translation.
 */
export interface PageResponse {
  slug: string;
  title: string;
  body: string;
  locale: string;
  publishedAt: string | null;
}

export function toPageResponse(page: ContentPage): PageResponse {
  return {
    slug: page.slug,
    title: page.title,
    body: page.body,
    locale: page.locale,
    publishedAt: page.publishedAt ? page.publishedAt.toISOString() : null,
  };
}
