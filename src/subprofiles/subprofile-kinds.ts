// Shared kind -> section config (GLOBAL CONTRACT C1). Authored once and
// mirrored verbatim in the frontend repo (`queerpulse/src/features/subprofiles/
// subprofile-kinds.ts`, which adds icons/labels). The string values here are
// identical to the `SubprofileKind` / `SubprofileSection` entity enums so the
// DB, the API, and the UI never drift. The backend uses this only to validate
// that a `section` belongs to a `kind`; field descriptors live on the FE.

// kind enum values
export type SubprofileKind =
  | 'developer' | 'writer' | 'musician' | 'visual_artist'
  | 'filmmaker' | 'designer' | 'maker' | 'generic';

// section enum values (union across all kinds + the universal 'links')
export type SubprofileSection =
  | 'projects' | 'open_source'          // developer
  | 'publications' | 'readings'         // writer
  | 'discography' | 'gigs'              // musician
  | 'portfolio' | 'exhibitions'        // visual_artist
  | 'filmography' | 'screenings'       // filmmaker
  | 'selected_work' | 'clients'        // designer
  | 'collections' | 'workshops'        // maker
  | 'showcase'                          // generic
  | 'links';                            // every kind

// kind -> ordered content sections (excludes the universal 'links')
export const KIND_SECTIONS: Record<SubprofileKind, SubprofileSection[]> = {
  developer:     ['projects', 'open_source'],
  writer:        ['publications', 'readings'],
  musician:      ['discography', 'gigs'],
  visual_artist: ['portfolio', 'exhibitions'],
  filmmaker:     ['filmography', 'screenings'],
  designer:      ['selected_work', 'clients'],
  maker:         ['collections', 'workshops'],
  generic:       ['showcase'],
};

// helpers (both repos)
export const sectionsForKind = (k: SubprofileKind): SubprofileSection[] =>
  [...KIND_SECTIONS[k], 'links'];
export const isSectionAllowed = (k: SubprofileKind, s: SubprofileSection): boolean =>
  sectionsForKind(k).includes(s);
export const isContentSection = (s: SubprofileSection): boolean => s !== 'links';
