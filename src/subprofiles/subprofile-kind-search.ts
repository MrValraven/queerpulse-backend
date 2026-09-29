import { foldSearchText } from '../search/search-text';
import type { SubprofileKind } from './subprofile-kinds';

/**
 * What a persona-directory search term can mean as a PROFESSION. The backend
 * keeps no kind labels anywhere else, so this table carries each kind's EN and
 * PT label (copied from the frontend's `KIND_LABELS` / `PT_KIND_LABELS` in
 * `subprofile-kinds.ts`; keep them in step) plus the extra words people search
 * with ("DM" for a game master). `directory()` ORs the matching kinds into its
 * predicate, so "dungeon master" finds game masters whatever they named their
 * persona.
 */
export const KIND_SEARCH_TERMS: Record<SubprofileKind, readonly string[]> = {
  developer: ['Developer', 'Programação'],
  writer: ['Writer', 'Escrita'],
  musician: ['Musician', 'Música'],
  visual_artist: ['Visual artist', 'Arte visual'],
  filmmaker: ['Filmmaker', 'Realização'],
  designer: ['Designer', 'Design'],
  maker: ['Maker', 'Maker'],
  drag: ['Drag performer', 'Arte drag'],
  dj: ['DJ', 'DJ'],
  dancer: ['Dancer', 'Dança'],
  performer: ['Performer', 'Performance'],
  photographer: ['Photographer', 'Fotografia'],
  videomaker: ['Videomaker', 'Videografia'],
  chef: ['Chef', 'Cozinha'],
  mixologist: ['Mixologist', 'Coquetelaria'],
  therapist: ['Therapist', 'Terapia'],
  astrologer: ['Astrologer', 'Astrologia'],
  generic: ['Other', 'Generalista'],
  comedian: ['Comedian', 'Comédia'],
  vocalist: ['Vocalist', 'Canto'],
  burlesque: ['Burlesque performer', 'Burlesco'],
  circus: ['Circus & aerial', 'Circo e aéreo'],
  spoken_word: ['Spoken word artist', 'Spoken word'],
  host: ['Host & emcee', 'Apresentação'],
  voguer: ['Ballroom & vogue', 'Ballroom e vogue'],
  illustrator: ['Illustrator', 'Ilustração'],
  tattoo_artist: ['Tattoo artist', 'Tatuagem'],
  animator: ['Animator', 'Animação'],
  comic_artist: ['Comic artist', 'Banda desenhada'],
  game_designer: ['Game designer', 'Videojogos'],
  artist_3d: ['3D artist', 'Arte 3D'],
  printmaker: ['Printmaker', 'Gravura'],
  journalist: ['Journalist', 'Jornalismo'],
  poet: ['Poet', 'Poesia'],
  editor: ['Editor', 'Edição'],
  screenwriter: ['Screenwriter', 'Argumento'],
  translator: ['Translator', 'Tradução'],
  zinester: ['Zinester', 'Fanzines'],
  academic: ['Academic', 'Investigação'],
  ceramicist: ['Ceramicist', 'Cerâmica'],
  jeweler: ['Jeweller', 'Joalharia'],
  textile_artist: ['Textile artist', 'Têxteis'],
  woodworker: ['Woodworker', 'Madeira'],
  florist: ['Florist', 'Floricultura'],
  data_scientist: ['Data scientist', 'Dados'],
  coach: ['Coach', 'Coaching'],
  bodyworker: ['Bodyworker & massage', 'Massagem'],
  yoga_teacher: ['Yoga & movement teacher', 'Yoga e movimento'],
  nutritionist: ['Nutritionist', 'Nutrição'],
  doula: ['Doula & birth worker', 'Doula'],
  personal_trainer: ['Personal trainer', 'Treino pessoal'],
  sex_educator: ['Sexual health educator', 'Educação sexual'],
  peer_support: ['Peer support & social work', 'Apoio entre pares'],
  baker: ['Baker & pastry chef', 'Pastelaria e pão'],
  barista: ['Barista', 'Barista'],
  brewer: ['Brewer & distiller', 'Cerveja e destilados'],
  sommelier: ['Sommelier', 'Escanção'],
  caterer: ['Caterer & supper club', 'Catering'],
  hair_stylist: ['Hair stylist', 'Cabelo'],
  barber: ['Barber', 'Barbearia'],
  makeup_artist: ['Makeup artist', 'Maquilhagem'],
  nail_artist: ['Nail artist', 'Unhas'],
  esthetician: ['Esthetician', 'Estética'],
  piercer: ['Piercer', 'Piercing'],
  fashion_designer: ['Fashion designer', 'Moda'],
  stylist: ['Stylist', 'Styling'],
  model: ['Model', 'Modelo'],
  costume_designer: ['Costume designer', 'Guarda-roupa'],
  curator: ['Curator', 'Curadoria'],
  gallerist: ['Gallerist', 'Galeria'],
  art_dealer: ['Art dealer', 'Comércio de arte'],
  archivist: ['Archivist', 'Arquivo'],
  conservator: ['Conservator', 'Conservação'],
  registrar: ['Registrar', 'Gestão de coleções'],
  exhibition_designer: ['Exhibition designer', 'Design expositivo'],
  art_critic: ['Art critic', 'Crítica de arte'],
  docent: ['Docent & gallery guide', 'Mediação'],
  preparator: ['Preparator & art handler', 'Montagem'],
  historian: ['Historian', 'História'],
  art_historian: ['Art historian', 'História da arte'],
  oral_historian: ['Oral historian', 'História oral'],
  genealogist: ['Genealogist', 'Genealogia'],
  heritage: ['Heritage & preservation', 'Património'],
  archival_researcher: ['Archival researcher', 'Pesquisa em arquivo'],
  memory_keeper: ['Cultural memory keeper', 'Memória cultural'],
  organizer: ['Organiser', 'Organização'],
  activist: ['Activist', 'Ativismo'],
  event_producer: ['Event producer', 'Produção de eventos'],
  promoter: ['Promoter', 'Promoção'],
  teacher: ['Teacher', 'Ensino'],
  facilitator: ['Workshop facilitator', 'Facilitação'],
  tutor: ['Tutor', 'Explicações'],
  lecturer: ['Lecturer', 'Docência universitária'],
  pole_dancer: ['Pole dancer', 'Pole dance'],
  // Quest personas (+20). EN/PT labels from the spec's kind catalogue table;
  // the aliases below are the extra words people search with.
  game_master: [
    'Game master (DM/GM)',
    'Narração de RPG',
    'dm',
    'gm',
    'dungeon master',
    'game master',
    'mestre',
    'mestre de jogo',
    'narrador',
    'narradora',
    'keeper',
    'storyteller',
    'rpg',
  ],
  ttrpg_designer: ['TTRPG writer', 'Escrita de RPG', 'ttrpg', 'rpg designer'],
  board_game_reviewer: [
    'Board game reviewer',
    'Crítica de jogos de tabuleiro',
    'board games',
    'jogos de tabuleiro',
  ],
  game_night_host: ['Game night host', 'Noites de jogos'],
  larp_organizer: ['LARP organiser', 'LARP', 'larp', 'live action'],
  miniature_painter: ['Miniature painter', 'Pintura de miniaturas'],
  cartographer: ['Fantasy map maker', 'Cartografia fantástica'],
  dice_maker: ['Dice maker', 'Dados artesanais'],
  tournament_organizer: [
    'Tournament organiser',
    'Organização de torneios',
    'tournament',
    'torneio',
    'magic',
    'mtg',
    'pokemon',
    'chess',
    'xadrez',
  ],
  actual_play: ['Actual play performer', 'Actual play'],
  streamer: ['Streamer / VTuber', 'Streaming', 'vtuber', 'twitch'],
  speedrunner: ['Speedrunner', 'Speedrunning'],
  modder: ['Modder', 'Modding'],
  cosplayer: ['Cosplayer', 'Cosplay', 'cosplay'],
  prop_maker: ['Prop and armour maker', 'Adereços e armaduras'],
  puzzle_designer: [
    'Puzzle and escape room designer',
    'Puzzles e escape rooms',
  ],
  podcaster: ['Podcaster', 'Podcast'],
  voice_actor: ['Voice actor', 'Dobragem e voz'],
  fanfic_writer: ['Fanfic writer', 'Fanfic'],
  game_critic: ['Video game critic', 'Crítica de videojogos'],
};

const MIN_TERM_LENGTH = 2;
const STOP_WORDS = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'e',
  'a',
  'o',
  'and',
  'of',
  'the',
]);
/** A match counts only where a word starts: at 0, or after one of these. */
const WORD_START_AFTER = new Set([' ', '-', '/', '(']);
/** A whole-word match also needs the word to end here: at the entry's end,
 *  or before one of these. */
const WORD_END_BEFORE = new Set([' ', '-', '/', '(', ')']);

const FOLDED_TERMS = (Object.keys(KIND_SEARCH_TERMS) as SubprofileKind[]).map(
  (kind) => ({
    kind,
    entries: KIND_SEARCH_TERMS[kind].map((entry) => foldSearchText(entry)),
  }),
);

function isAtWordBoundary(haystack: string, needle: string): boolean {
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    if (index === 0 || WORD_START_AFTER.has(haystack[index - 1] ?? '')) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * Same word-start rule as `isAtWordBoundary`, but also requires the needle to
 * be a WHOLE word: the character right after the match has to end the word
 * too (the end of the entry, or a word break). Reserved for two-character
 * needles, where a bare prefix match fans out to every kind with any word
 * starting with those two letters ("es" hitting Escrita, Estética, Escanção,
 * "escape rooms"...). "dm", "gm" and "dj" still match, since each is a whole
 * word in an alias or a label.
 */
function isWholeWordMatch(haystack: string, needle: string): boolean {
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const isWordStart =
      index === 0 || WORD_START_AFTER.has(haystack[index - 1] ?? '');
    const wordEndIndex = index + needle.length;
    const isWordEnd =
      wordEndIndex === haystack.length ||
      WORD_END_BEFORE.has(haystack[wordEndIndex] ?? '');
    if (isWordStart && isWordEnd) {
      return true;
    }
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

/**
 * The kinds a directory search term names, by label or alias, accent- and
 * case-folded. Empty for terms under two characters and for stop words, so a
 * search for "de" keeps its plain name/tagline results. A two-character
 * needle must match a whole word (see `isWholeWordMatch`); three or more
 * characters keep the plain word-start prefix match.
 */
export function kindsMatchingSearch(term: string): SubprofileKind[] {
  const needle = foldSearchText(term.trim());
  if (needle.length < MIN_TERM_LENGTH || STOP_WORDS.has(needle)) return [];
  const matchesEntry =
    needle.length === 2
      ? (entry: string) => isWholeWordMatch(entry, needle)
      : (entry: string) => isAtWordBoundary(entry, needle);
  return FOLDED_TERMS.filter(({ entries }) => entries.some(matchesEntry)).map(
    ({ kind }) => kind,
  );
}
