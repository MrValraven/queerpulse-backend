// Shared kind -> section config (GLOBAL CONTRACT C1). Authored once and
// mirrored verbatim in the frontend repo (`queerpulse/src/features/subprofiles/
// subprofile-kinds.ts`, which adds icons/labels). The string values here are
// identical to the `SubprofileKind` / `SubprofileSection` entity enums so the
// DB, the API, and the UI never drift. The backend uses this to validate that
// a `section` belongs to a `kind`, to decide at read time which stored sections
// a persona shows, and to hold the family map that kind changes are checked
// against. Field descriptors live on the FE.

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
  | 'video_creator'
  | 'short_form_creator'
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
  | 'architect'
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
  | 'lecturer'
  | 'pole_dancer'
  // Quest personas (+20)
  | 'game_master'
  | 'ttrpg_designer'
  | 'board_game_reviewer'
  | 'game_night_host'
  | 'larp_organizer'
  | 'miniature_painter'
  | 'cartographer'
  | 'dice_maker'
  | 'tournament_organizer'
  | 'actual_play'
  | 'streamer'
  | 'speedrunner'
  | 'modder'
  | 'cosplayer'
  | 'prop_maker'
  | 'puzzle_designer'
  | 'podcaster'
  | 'podcast_producer'
  | 'radio_host'
  | 'voice_actor'
  | 'fanfic_writer'
  | 'game_critic';

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
  | 'subjects'
  // Quest personas (+16). 'campaigns' is not repeated here: it is already a
  // union member above (organizer/activist/heritage/model), reused verbatim
  // by game_master.
  | 'sessions'
  | 'playthroughs'
  | 'library'
  | 'larps'
  | 'minis'
  | 'maps'
  | 'dice'
  | 'results'
  | 'streams'
  | 'runs'
  | 'mods'
  | 'cons'
  | 'puzzles'
  | 'episodes'
  | 'roles'
  | 'works'
  // Tattoo artist (+7)
  | 'cover_ups'
  | 'scar_work'
  | 'in_progress'
  | 'wanna_dos'
  | 'guest_spots'
  | 'flash_days'
  | 'shop'
  // Architect (+2). 'projects' is reused from above.
  | 'built_work'
  | 'competitions';

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
  video_creator: ['videos', 'series'],
  short_form_creator: ['videos', 'campaigns'],
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
  tattoo_artist: [
    'flash',
    'healed',
    'wanna_dos',
    'in_progress',
    'cover_ups',
    'scar_work',
    'aftercare',
    'credentials',
    'guest_spots',
    'flash_days',
    'shop',
  ],
  animator: ['reel', 'clients'],
  comic_artist: ['books', 'strips'],
  game_designer: ['games', 'jams'],
  artist_3d: ['models', 'clients'],
  printmaker: ['editions', 'workshops'],
  architect: ['built_work', 'projects', 'competitions'],
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
  pole_dancer: ['performances', 'classes', 'reel', 'workshops'],
  // Quest personas (+20). Identical mapping to the FE mirror.
  game_master: ['campaigns', 'sessions'],
  ttrpg_designer: ['games', 'jams'],
  board_game_reviewer: ['reviews', 'playthroughs'],
  game_night_host: ['nights', 'library'],
  larp_organizer: ['larps', 'workshops'],
  miniature_painter: ['minis', 'commissions'],
  cartographer: ['maps', 'commissions'],
  dice_maker: ['dice', 'commissions'],
  tournament_organizer: ['events', 'results'],
  actual_play: ['shows', 'appearances'],
  streamer: ['streams', 'videos'],
  speedrunner: ['runs', 'videos'],
  modder: ['mods', 'open_source'],
  cosplayer: ['builds', 'cons'],
  prop_maker: ['builds', 'commissions'],
  puzzle_designer: ['puzzles', 'events'],
  podcaster: ['episodes', 'appearances'],
  podcast_producer: ['productions', 'clients'],
  radio_host: ['episodes', 'appearances'],
  voice_actor: ['reel', 'roles'],
  fanfic_writer: ['works', 'series'],
  game_critic: ['reviews', 'publications'],
};

/** The page families. A member never picks one: it is derived from `kind`. */
export type SkinFamily =
  | 'stage'
  | 'studio'
  | 'page'
  | 'workshop'
  | 'practice'
  | 'table'
  | 'chart'
  | 'chair'
  | 'runway'
  | 'gallery'
  | 'history'
  | 'collective'
  | 'classroom'
  | 'quest';

// kind -> page family. Total over SubprofileKind. Copied value for value from
// the frontend `SKIN_OF` in `queerpulse/src/features/subprofiles/subprofile-skins.ts`;
// `queerpulse/scripts/check-work-taxonomy.mjs` parses this literal, so keep one
// `kind: 'family',` entry per line. A kind change is only allowed inside a family.
export const FAMILY_OF_KIND: Record<SubprofileKind, SkinFamily> = {
  drag: 'stage',
  dj: 'stage',
  dancer: 'stage',
  performer: 'stage',
  musician: 'stage',
  visual_artist: 'studio',
  photographer: 'studio',
  filmmaker: 'studio',
  videomaker: 'studio',
  video_creator: 'studio',
  short_form_creator: 'studio',
  designer: 'studio',
  writer: 'page',
  developer: 'workshop',
  maker: 'workshop',
  generic: 'workshop',
  therapist: 'practice',
  chef: 'table',
  mixologist: 'table',
  astrologer: 'chart',
  // stage (new kinds)
  comedian: 'stage',
  vocalist: 'stage',
  burlesque: 'stage',
  circus: 'stage',
  spoken_word: 'stage',
  host: 'stage',
  voguer: 'stage',
  pole_dancer: 'stage',
  // studio (new kinds)
  illustrator: 'studio',
  tattoo_artist: 'studio',
  animator: 'studio',
  comic_artist: 'studio',
  game_designer: 'quest', // moved from studio (Quest personas)
  artist_3d: 'studio',
  printmaker: 'studio',
  architect: 'studio',
  // page (new kinds)
  journalist: 'page',
  poet: 'page',
  editor: 'page',
  screenwriter: 'page',
  translator: 'page',
  zinester: 'page',
  academic: 'page',
  // workshop (new kinds)
  ceramicist: 'workshop',
  jeweler: 'workshop',
  textile_artist: 'workshop',
  woodworker: 'workshop',
  florist: 'workshop',
  data_scientist: 'workshop',
  // practice (new kinds)
  coach: 'practice',
  bodyworker: 'practice',
  yoga_teacher: 'practice',
  nutritionist: 'practice',
  doula: 'practice',
  personal_trainer: 'practice',
  sex_educator: 'practice',
  peer_support: 'practice',
  // table (new kinds)
  baker: 'table',
  barista: 'table',
  brewer: 'table',
  sommelier: 'table',
  caterer: 'table',
  // chair (new family)
  hair_stylist: 'chair',
  barber: 'chair',
  makeup_artist: 'chair',
  nail_artist: 'chair',
  esthetician: 'chair',
  piercer: 'chair',
  // runway (new family)
  fashion_designer: 'runway',
  stylist: 'runway',
  model: 'runway',
  costume_designer: 'runway',
  // gallery (new family)
  curator: 'gallery',
  gallerist: 'gallery',
  art_dealer: 'gallery',
  archivist: 'gallery',
  conservator: 'gallery',
  registrar: 'gallery',
  exhibition_designer: 'gallery',
  art_critic: 'gallery',
  docent: 'gallery',
  preparator: 'gallery',
  // history (new family, the Record)
  historian: 'history',
  art_historian: 'history',
  oral_historian: 'history',
  genealogist: 'history',
  heritage: 'history',
  archival_researcher: 'history',
  memory_keeper: 'history',
  // collective (new family, the Poster)
  organizer: 'collective',
  activist: 'collective',
  event_producer: 'collective',
  promoter: 'collective',
  // classroom (new family)
  teacher: 'classroom',
  facilitator: 'classroom',
  tutor: 'classroom',
  lecturer: 'classroom',
  // Quest personas (+20): the quest family, plus two new stage kinds and
  // two new page kinds.
  game_master: 'quest',
  ttrpg_designer: 'quest',
  board_game_reviewer: 'quest',
  game_night_host: 'quest',
  larp_organizer: 'quest',
  miniature_painter: 'quest',
  cartographer: 'quest',
  dice_maker: 'quest',
  tournament_organizer: 'quest',
  actual_play: 'quest',
  streamer: 'quest',
  speedrunner: 'quest',
  modder: 'quest',
  cosplayer: 'quest',
  prop_maker: 'quest',
  puzzle_designer: 'quest',
  podcaster: 'stage',
  podcast_producer: 'stage',
  radio_host: 'stage',
  voice_actor: 'stage',
  fanfic_writer: 'page',
  game_critic: 'page',
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

/**
 * Whether a stored section shows for a persona of this kind. `gallery` passes
 * because `sectionsForKind` appends it. `links` passes explicitly because
 * `sectionsForKind` leaves out the retired `links` tombstone, while the
 * frontend adds it back on top of `sectionsForKind`.
 */
export const isSectionVisibleForKind = (
  kind: SubprofileKind,
  section: SubprofileSection,
): boolean => section === 'links' || sectionsForKind(kind).includes(section);

/** Keeps the items whose section shows for the kind, in input order, as a new array. */
export function visibleItemsForKind<
  Item extends { section: SubprofileSection },
>(kind: SubprofileKind, items: readonly Item[]): Item[] {
  return items.filter((item) => isSectionVisibleForKind(kind, item.section));
}
