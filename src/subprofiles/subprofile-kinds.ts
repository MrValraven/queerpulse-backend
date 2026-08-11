// Shared kind -> section config (GLOBAL CONTRACT C1). Authored once and
// mirrored verbatim in the frontend repo (`queerpulse/src/features/subprofiles/
// subprofile-kinds.ts`, which adds icons/labels). The string values here are
// identical to the `SubprofileKind` / `SubprofileSection` entity enums so the
// DB, the API, and the UI never drift. The backend uses this only to validate
// that a `section` belongs to a `kind`; field descriptors live on the FE.

// kind enum values
export type SubprofileKind =
  | 'developer'
  | 'writer'
  | 'musician'
  | 'visual_artist'
  | 'filmmaker'
  | 'designer'
  | 'maker'
  | 'drag'
  | 'dj'
  | 'dancer'
  | 'performer'
  | 'photographer'
  | 'videomaker'
  | 'chef'
  | 'mixologist'
  | 'therapist'
  | 'astrologer'
  | 'generic'
  // Persona families + crafts expansion (+75). Kept in lockstep with the
  // `SubprofileKind` entity enum and the FE mirror.
  // stage
  | 'comedian'
  | 'vocalist'
  | 'burlesque'
  | 'circus'
  | 'spoken_word'
  | 'host'
  | 'voguer'
  // studio
  | 'illustrator'
  | 'tattoo_artist'
  | 'animator'
  | 'comic_artist'
  | 'game_designer'
  | 'artist_3d'
  | 'printmaker'
  // page
  | 'journalist'
  | 'poet'
  | 'editor'
  | 'screenwriter'
  | 'translator'
  | 'zinester'
  | 'academic'
  // workshop
  | 'ceramicist'
  | 'jeweler'
  | 'textile_artist'
  | 'woodworker'
  | 'florist'
  | 'data_scientist'
  // practice
  | 'coach'
  | 'bodyworker'
  | 'yoga_teacher'
  | 'nutritionist'
  | 'doula'
  | 'personal_trainer'
  | 'sex_educator'
  | 'peer_support'
  // table
  | 'baker'
  | 'barista'
  | 'brewer'
  | 'sommelier'
  | 'caterer'
  // chair (new family)
  | 'hair_stylist'
  | 'barber'
  | 'makeup_artist'
  | 'nail_artist'
  | 'esthetician'
  | 'piercer'
  // runway (new family)
  | 'fashion_designer'
  | 'stylist'
  | 'model'
  | 'costume_designer'
  // gallery (new family)
  | 'curator'
  | 'gallerist'
  | 'art_dealer'
  | 'archivist'
  | 'conservator'
  | 'registrar'
  | 'exhibition_designer'
  | 'art_critic'
  | 'docent'
  | 'preparator'
  // history (new family — display name "Record")
  | 'historian'
  | 'art_historian'
  | 'oral_historian'
  | 'genealogist'
  | 'heritage'
  | 'archival_researcher'
  | 'memory_keeper'
  // collective (new family — display name "Poster")
  | 'organizer'
  | 'activist'
  | 'event_producer'
  | 'promoter'
  // classroom (new family)
  | 'teacher'
  | 'facilitator'
  | 'tutor'
  | 'lecturer';

// section enum values (union across all kinds + the universal 'links')
export type SubprofileSection =
  | 'projects'
  | 'open_source' // developer
  | 'publications'
  | 'readings' // writer
  | 'discography'
  | 'gigs' // musician + dj
  | 'portfolio'
  | 'exhibitions' // visual_artist + photographer
  | 'filmography'
  | 'screenings' // filmmaker + videomaker
  | 'selected_work'
  | 'clients' // designer
  | 'collections'
  | 'workshops' // maker
  | 'shows'
  | 'looks' // drag
  | 'mixes' // dj
  | 'performances'
  | 'reel' // dancer + performer
  | 'appearances' // performer
  | 'series' // photographer
  | 'videos' // videomaker
  | 'menus' // chef
  | 'residencies' // chef + mixologist
  | 'cocktails' // mixologist
  | 'specialisms'
  | 'credentials' // therapist
  | 'charts'
  | 'sky' // astrologer
  | 'showcase' // generic
  | 'gallery' // every kind
  | 'links' // every kind
  // Persona families + crafts expansion (+81). Several are shared across the new
  // kinds and declared once. Kept in lockstep with the `SubprofileSection`
  // entity enum and the FE mirror.
  | 'sets'
  | 'tour'
  | 'recordings'
  | 'acts'
  | 'pieces'
  | 'hosted'
  | 'balls'
  | 'flash'
  | 'healed'
  | 'books'
  | 'strips'
  | 'games'
  | 'jams'
  | 'models'
  | 'editions'
  | 'reporting'
  | 'bylines'
  | 'poems'
  | 'edited'
  | 'scripts'
  | 'productions'
  | 'translations'
  | 'languages'
  | 'zines'
  | 'distros'
  | 'papers'
  | 'teaching'
  | 'wares'
  | 'firings'
  | 'commissions'
  | 'builds'
  | 'arrangements'
  | 'events'
  | 'analyses'
  | 'programmes'
  | 'treatments'
  | 'classes'
  | 'trainings'
  | 'support'
  | 'training'
  | 'resources'
  | 'groups'
  | 'bakes'
  | 'markets'
  | 'brews'
  | 'releases'
  | 'taprooms'
  | 'lists'
  | 'pairings'
  | 'services'
  | 'cuts'
  | 'nail_sets'
  | 'aftercare'
  | 'piercings'
  | 'editorials'
  | 'book'
  | 'campaigns'
  | 'sketches'
  | 'texts'
  | 'programme'
  | 'artists'
  | 'available'
  | 'advisory'
  | 'finding_aids'
  | 'loans'
  | 'installations'
  | 'reviews'
  | 'tours'
  | 'talks'
  | 'installs'
  | 'research'
  | 'lectures'
  | 'testimonies'
  | 'findings'
  | 'sites'
  | 'actions'
  | 'writing'
  | 'nights'
  | 'roster'
  | 'courses'
  | 'subjects';

// kind -> ordered content sections (excludes the universal 'links')
export const KIND_SECTIONS: Record<SubprofileKind, SubprofileSection[]> = {
  developer: ['projects', 'open_source'],
  writer: ['publications', 'readings'],
  musician: ['discography', 'gigs'],
  visual_artist: ['portfolio', 'exhibitions'],
  filmmaker: ['filmography', 'screenings'],
  designer: ['selected_work', 'clients'],
  maker: ['collections', 'workshops'],
  drag: ['shows', 'looks'],
  dj: ['mixes', 'gigs'],
  dancer: ['performances', 'reel'],
  performer: ['appearances', 'reel'],
  photographer: ['series', 'exhibitions'],
  videomaker: ['videos', 'screenings'],
  chef: ['menus', 'residencies'],
  mixologist: ['cocktails', 'residencies'],
  therapist: ['specialisms', 'credentials'],
  astrologer: ['charts', 'sky'],
  generic: ['showcase'],
  // Persona families + crafts expansion (+75). Identical mapping to the FE
  // mirror's `KIND_SECTIONS`. Some entries reference existing sections
  // (e.g. `gigs`, `clients`, `readings`, `projects`) alongside the new ones.
  // stage
  comedian: ['sets', 'tour'],
  vocalist: ['recordings', 'gigs'],
  burlesque: ['acts', 'looks'],
  circus: ['acts', 'reel'],
  spoken_word: ['pieces', 'readings'],
  host: ['hosted', 'appearances'],
  voguer: ['balls', 'reel'],
  // studio
  illustrator: ['portfolio', 'clients'],
  tattoo_artist: ['flash', 'healed'],
  animator: ['reel', 'clients'],
  comic_artist: ['books', 'strips'],
  game_designer: ['games', 'jams'],
  artist_3d: ['models', 'clients'],
  printmaker: ['editions', 'workshops'],
  // page
  journalist: ['reporting', 'bylines'],
  poet: ['poems', 'readings'],
  editor: ['edited', 'clients'],
  screenwriter: ['scripts', 'productions'],
  translator: ['translations', 'languages'],
  zinester: ['zines', 'distros'],
  academic: ['papers', 'teaching'],
  // workshop
  ceramicist: ['wares', 'firings'],
  jeweler: ['pieces', 'commissions'],
  textile_artist: ['pieces', 'workshops'],
  woodworker: ['builds', 'commissions'],
  florist: ['arrangements', 'events'],
  data_scientist: ['analyses', 'open_source'],
  // practice
  coach: ['programmes', 'credentials'],
  bodyworker: ['treatments', 'credentials'],
  yoga_teacher: ['classes', 'trainings'],
  nutritionist: ['specialisms', 'credentials'],
  doula: ['support', 'credentials'],
  personal_trainer: ['training', 'credentials'],
  sex_educator: ['workshops', 'resources'],
  peer_support: ['groups', 'credentials'],
  // table
  baker: ['bakes', 'markets'],
  barista: ['brews', 'residencies'],
  brewer: ['releases', 'taprooms'],
  sommelier: ['lists', 'pairings'],
  caterer: ['menus', 'events'],
  // chair (new family)
  hair_stylist: ['services', 'looks'],
  barber: ['services', 'cuts'],
  makeup_artist: ['looks', 'clients'],
  nail_artist: ['nail_sets', 'services'],
  esthetician: ['treatments', 'aftercare'],
  piercer: ['piercings', 'aftercare'],
  // runway (new family)
  fashion_designer: ['collections', 'shows'],
  stylist: ['editorials', 'clients'],
  model: ['book', 'campaigns'],
  costume_designer: ['productions', 'sketches'],
  // gallery (new family)
  curator: ['exhibitions', 'texts'],
  gallerist: ['programme', 'artists'],
  art_dealer: ['available', 'advisory'],
  archivist: ['collections', 'finding_aids'],
  conservator: ['treatments', 'credentials'],
  registrar: ['collections', 'loans'],
  exhibition_designer: ['installations', 'clients'],
  art_critic: ['reviews', 'publications'],
  docent: ['tours', 'talks'],
  preparator: ['installs', 'clients'],
  // history (new family — display name "Record")
  historian: ['research', 'publications'],
  art_historian: ['research', 'lectures'],
  oral_historian: ['testimonies', 'projects'],
  genealogist: ['services', 'findings'],
  heritage: ['sites', 'campaigns'],
  archival_researcher: ['research', 'finding_aids'],
  memory_keeper: ['projects', 'testimonies'],
  // collective (new family — display name "Poster")
  organizer: ['campaigns', 'actions'],
  activist: ['campaigns', 'writing'],
  event_producer: ['events', 'clients'],
  promoter: ['nights', 'roster'],
  // classroom (new family)
  teacher: ['courses', 'resources'],
  facilitator: ['workshops', 'clients'],
  tutor: ['subjects', 'courses'],
  lecturer: ['courses', 'papers'],
};

// helpers (both repos)
// Appends the universal 'gallery' section. ('links' is a retired section — the
// enum value stays as a harmless tombstone but it is no longer produced here.)
export const sectionsForKind = (k: SubprofileKind): SubprofileSection[] => [
  ...KIND_SECTIONS[k],
  'gallery',
];
export const isSectionAllowed = (
  k: SubprofileKind,
  s: SubprofileSection,
): boolean => sectionsForKind(k).includes(s);
export const isContentSection = (s: SubprofileSection): boolean =>
  s !== 'links';
