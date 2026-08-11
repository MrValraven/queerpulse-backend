import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { MediaReference } from './media-reference.types';
import {
  MEDIA_REFERENCE_SOURCES,
  storedForms,
  toBareKey,
} from './media-reference-sources';

export interface MediaReferenceResolution {
  references: Map<string, MediaReference[]>;
  /** True when at least one source query threw and was swallowed — the
   *  reference set is therefore INCOMPLETE and "no references" is not
   *  authoritative for deletion. */
  degraded: boolean;
}

@Injectable()
export class MediaReferenceResolver {
  private readonly logger = new Logger(MediaReferenceResolver.name);
  constructor(private readonly dataSource: DataSource) {}

  /** Maps each in-use bare key -> every place it is referenced. Absent keys are
   *  not in use. Matching is by value (bare key + `/files/<key>`); serves both
   *  the self-scoped my-media list and the cross-user admin console.
   *
   *  Returns `degraded: true` when any source query threw and was swallowed, so
   *  callers can tell "no references" (authoritative) apart from "some checks
   *  couldn't run" (not safe to treat as a green light for deletion). */
  async resolve(bareKeys: string[]): Promise<MediaReferenceResolution> {
    const candidateBareKeys = new Set(bareKeys.map(toBareKey));
    const result = new Map<string, MediaReference[]>();
    if (candidateBareKeys.size === 0)
      return { references: result, degraded: false };

    const candidateStoredForms = storedForms([...candidateBareKeys]);
    let degraded = false;

    for (const source of MEDIA_REFERENCE_SOURCES) {
      try {
        const matches = await source.resolve(
          this.dataSource,
          candidateBareKeys,
          candidateStoredForms,
        );
        for (const [bareKey, reference] of matches) {
          if (!candidateBareKeys.has(bareKey)) continue; // defensive
          const existingReferences = result.get(bareKey);
          if (existingReferences) existingReferences.push(reference);
          else result.set(bareKey, [reference]);
        }
      } catch (error) {
        // One source erroring degrades to "not counted", never a 500. The
        // coverage tripwire guarantees the source is WIRED; this only guards
        // runtime DB errors. Flag the whole resolution as degraded so callers
        // never present an incomplete reference set as "safe to delete".
        degraded = true;
        this.logger.error(
          `media-reference source ${source.field} failed: ${String(error)}`,
        );
      }
    }
    return { references: result, degraded };
  }
}
