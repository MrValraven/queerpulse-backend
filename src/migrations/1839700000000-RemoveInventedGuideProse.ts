// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Takes invented guide prose and card copy out of the `resources` table.
 *
 * `BackfillResourceGuides1794833210000` transcribed the old frontend catalogs
 * into `resources`. Several of those pages described things that do not exist
 * on QueerPulse: a Lisbon running group with three pace groups, "Rainbow Arts"
 * crit sessions and a shared risograph/kiln/projector kit, a uniform meetup
 * format ("a small pile of books on the table", "the next meetup is on the
 * board"), a Thursday peer-support circle with mod pairing and an orientation,
 * an "elders group" with a practitioner list, and "every gathering is hybrid".
 * The owner has ruled that nothing invented may appear on a public page, and
 * the hardcoded pages have been rewritten as honest, general guidance. But
 * `ManagedGuide` serves the database `sections` instead of the hardcoded page
 * once a row is published AND review-stamped, so the invented prose would
 * still reach readers. This migration removes it.
 *
 * Two kinds of change, each guarded so an editor's later work is left alone:
 *
 *  1. Card copy (`title`, `title_pt`, `description`, `description_pt`, and
 *     `body` on the metadata-only rows, where the backfill used the English
 *     description as the body) is swapped to the corrected text, one column at
 *     a time, and only while the column still holds the exact text the
 *     backfill wrote. Same technique as `RefreshGuideLibraryCopy1828740000000`.
 *     The new text equals the `meta.title` / `meta.description` of the matching
 *     page in the frontend catalogs.
 *
 *  2. Prose: for each slug below whose seeded `sections` carry an invented
 *     claim, `sections` becomes `[]`, `sections_pt` becomes NULL and `body`
 *     becomes the row's `description`. An empty `sections` makes the frontend
 *     fall back to the hardcoded page (`useManagedGuide.hasManagedBody` is
 *     false), which still renders with the row's review footer, so the page
 *     keeps working. The guard is a MARKER: one exact sentence from the seeded
 *     English sections that is itself the invented claim. The row is touched
 *     only while `sections::text` still contains it. Any edit through the
 *     admin editor rewrites `sections` (and recomputes `body` from them), so
 *     an editor-authored row no longer carries the marker and is never
 *     matched. Running again finds no marker and changes nothing.
 *
 * Slugs checked and left alone: `community-privacy` (its claims about a
 * "coming-out space" cannot be confirmed or refuted from the backend, so it is
 * not touched) and `peer-support` card copy (clean; only its prose is invented).
 *
 * The review stamp (`last_reviewed_on`, `reviewed_by`) is deliberately kept,
 * so the guides stay public and read from the new hardcoded pages.
 *
 * The seeded and replacement strings are written out here on purpose, so this
 * migration does not depend on whatever the frontend catalogs say on the day
 * it runs. A migration file exports only its class: TypeORM would `new` any
 * exported function.
 */
interface GuideCopySwap {
  slug: string;
  column: 'title' | 'title_pt' | 'description' | 'description_pt' | 'body';
  from: string;
  to: string;
}

/** One exact sentence of the seeded English sections that is an invented claim. */
interface InventedProseMarker {
  slug: string;
  marker: string;
}

const COPY_SWAPS: GuideCopySwap[] = [
  {
    slug: 'art-crit-guide',
    column: 'title',
    from: 'How Rainbow Arts crit sessions work',
    to: 'How group art critiques work',
  },
  {
    slug: 'art-crit-guide',
    column: 'title_pt',
    from: 'Como funcionam as críticas de grupo da Artes Arco-Íris',
    to: 'Como funcionam as críticas de grupo de arte',
  },
  {
    slug: 'art-crit-guide',
    column: 'description',
    from:
      'How Rainbow Arts group critiques work: the honest, kind, specific method, the four-step flow, and examples of useful versus unhelpful feedback.',
    to:
      'A practical method for group critiques: honest, kind and specific feedback, a four-step session flow, and examples of useful and unhelpful comments.',
  },
  {
    slug: 'art-crit-guide',
    column: 'description_pt',
    from:
      'Como funcionam as sessões de crítica de grupo da Artes Arco-Íris: o método honesto, gentil e específico, os quatro passos, e exemplos de feedback útil.',
    to:
      'Um método prático para críticas de grupo: feedback honesto, gentil e específico, os quatro passos de uma sessão e exemplos de comentários úteis e inúteis.',
  },
  {
    slug: 'first-meetup-guide',
    column: 'title',
    from: 'Your first QueerPulse meetup: what to expect',
    to: 'Your first community meetup: what to expect',
  },
  {
    slug: 'first-meetup-guide',
    column: 'title_pt',
    from: 'O teu primeiro encontro QueerPulse: o que esperar',
    to: 'O teu primeiro evento da comunidade: o que esperar',
  },
  {
    slug: 'first-meetup-guide',
    column: 'description',
    from:
      "What actually happens at a first in-person meetup, what 'no agenda' really means, and honest answers to the questions newcomers are too nervous to ask.",
    to:
      'What tends to happen at a first in-person meetup, how to ease the nerves, and honest answers to the questions newcomers are too nervous to ask.',
  },
  {
    slug: 'first-meetup-guide',
    column: 'description_pt',
    from:
      "O que acontece de facto num primeiro encontro presencial, o que 'sem agenda' significa na prática, e respostas às perguntas que quem chega tem medo de fazer.",
    to:
      'O que costuma acontecer num primeiro evento presencial, como aliviar o nervosismo, e respostas às perguntas que quem chega tem medo de fazer.',
  },
  {
    slug: 'running-guide',
    column: 'title',
    from: 'Queer running group in Lisbon: pace groups and what to bring',
    to: 'Joining a group run: pace groups and what to bring',
  },
  {
    slug: 'running-guide',
    column: 'title_pt',
    from: 'Grupo de corrida queer em Lisboa: ritmos e o que levar',
    to: 'Juntar-te a uma corrida em grupo: ritmos e o que levar',
  },
  {
    slug: 'running-guide',
    column: 'description',
    from:
      "QueerPulse's Lisbon running group: three pace groups from social to steady, what to bring on your first run, and the rule that matters most: nobody runs alone.",
    to:
      'Practical guidance for joining or organising a group run: how pace groups usually work, what to bring on a first run, and why nobody should run alone.',
  },
  {
    slug: 'running-guide',
    column: 'description_pt',
    from:
      'O grupo de corrida da QueerPulse em Lisboa: três grupos de ritmo, do social ao mais exigente, o que levar à primeira corrida, e a regra mais importante de todas, ninguém corre sozinhe.',
    to:
      'Orientações práticas para quem quer juntar-se a uma corrida em grupo ou organizar uma: como costumam funcionar os grupos de ritmo, o que levar à primeira corrida e porque ninguém deve correr sozinhe.',
  },
  {
    slug: 'shared-equipment',
    column: 'title',
    from: 'Shared studio equipment: the Rainbow Arts kit library',
    to: 'Sharing studio equipment: booking and care',
  },
  {
    slug: 'shared-equipment',
    column: 'title_pt',
    from: 'Equipamento partilhado: o material do coletivo Rainbow Arts',
    to: 'Partilhar equipamento de atelier: reservas e cuidados',
  },
  {
    slug: 'shared-equipment',
    column: 'description',
    from:
      "The risograph, kiln, projector and bookbinding kit the Rainbow Arts collective shares in Lisbon: what's available, how to book it, and how the community keeps it in good shape.",
    to:
      'Practical guidance for people who share studio equipment such as a risograph, kiln, projector or bookbinding kit: how to book it, clean it, log it and cover the costs.',
  },
  {
    slug: 'shared-equipment',
    column: 'description_pt',
    from:
      'A risógrafa, o forno de cerâmica, o projetor e o kit de encadernação que o coletivo Rainbow Arts partilha em Lisboa: o que está disponível, como reservar, e como cuidamos do material.',
    to:
      'Orientações práticas para quem partilha equipamento de atelier, como uma risógrafa, um forno de cerâmica, um projetor ou um kit de encadernação: como reservar, limpar, registar e repartir os custos.',
  },
  {
    slug: 'spoon-theory',
    column: 'description',
    from:
      "What spoon theory means, and how QueerPulse applies it for chronic illness and disability: hybrid events by default, no-penalty drop-outs, and permission to say 'I'm low on spoons.'",
    to:
      'What spoon theory means, and how to use it on QueerPulse when you have chronic illness or a disability: accessibility details on events, online events, and a place to share your access needs when you RSVP.',
  },
  {
    slug: 'spoon-theory',
    column: 'description_pt',
    from:
      "O que é a teoria das colheres e como a QueerPulse a usa para doença crónica e deficiência: eventos híbridos por defeito, faltar sem penalização, e 'estou com poucas colheres' como frase válida.",
    to:
      'O que é a teoria das colheres e como a usar na QueerPulse se tens doença crónica ou deficiência: detalhes de acessibilidade nos eventos, eventos online, e um campo para indicares as tuas necessidades de acesso ao confirmares presença.',
  },
  {
    slug: 'group-show-archive',
    column: 'title',
    from: 'Rainbow Arts: an archive of every group show',
    to: 'Group show archive: a record of art shows',
  },
  {
    slug: 'group-show-archive',
    column: 'title_pt',
    from: 'Artes Arco-Íris: arquivo de todas as exposições',
    to: 'Arquivo de exposições de grupo: um registo de mostras de arte',
  },
  {
    slug: 'group-show-archive',
    column: 'description',
    from:
      'An archive of every Rainbow Arts group show, with dates, venues, and what was made, from the first pop-up to the most recent weekend residency.',
    to:
      'A place to keep a record of group art shows: the title, when and where it hung, and who made the work.',
  },
  {
    slug: 'group-show-archive',
    column: 'description_pt',
    from:
      'Um arquivo de todas as exposições de grupo da Artes Arco-Íris: datas, locais e o que foi feito, desde o primeiro pop-up até à residência mais recente.',
    to:
      'Um lugar para guardar o registo de exposições de arte em grupo: o título, quando e onde foi montada, e quem fez o trabalho.',
  },
  {
    slug: 'group-show-archive',
    column: 'body',
    from:
      'An archive of every Rainbow Arts group show, with dates, venues, and what was made, from the first pop-up to the most recent weekend residency.',
    to:
      'A place to keep a record of group art shows: the title, when and where it hung, and who made the work.',
  },
  {
    slug: 'ingredients-map',
    column: 'description',
    from:
      'A community-mapped guide to Lisbon grocers, markets, and stalls carrying ingredients from home, organised by neighbourhood, from Mouraria to Marvila.',
    to:
      "A neighbourhood-by-neighbourhood guide to finding ingredients from home in Lisbon's grocers, markets and stalls.",
  },
  {
    slug: 'ingredients-map',
    column: 'description_pt',
    from:
      'Um mapa feito pela comunidade de mercearias, mercados e bancas em Lisboa com ingredientes de casa, organizado por bairro, da Mouraria a Marvila.',
    to:
      'Um guia, bairro a bairro, para encontrar ingredientes de casa nas mercearias, mercados e bancas de Lisboa.',
  },
  {
    slug: 'ingredients-map',
    column: 'body',
    from:
      'A community-mapped guide to Lisbon grocers, markets, and stalls carrying ingredients from home, organised by neighbourhood, from Mouraria to Marvila.',
    to:
      "A neighbourhood-by-neighbourhood guide to finding ingredients from home in Lisbon's grocers, markets and stalls.",
  },
  {
    slug: 'qtipoc-archive',
    column: 'title',
    from: "QTIPOC archive: Lisbon's community-held queer history",
    to: 'QTIPOC archive: a community-held record of life in Lisbon',
  },
  {
    slug: 'qtipoc-archive',
    column: 'title_pt',
    from: 'Arquivo QTIPOC: memória viva da comunidade queer em Lisboa',
    to: 'Arquivo QTIPOC: um registo da vida em Lisboa, mantido pela comunidade',
  },
  {
    slug: 'qtipoc-archive',
    column: 'description',
    from:
      'A living, community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
    to:
      'The idea behind a community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
  },
  {
    slug: 'qtipoc-archive',
    column: 'description_pt',
    from:
      'Um arquivo vivo da vida QTIPOC em Lisboa: ensaios fotográficos, escrita, gravações e documentos, contribuídos e creditados por quem os criou.',
    to:
      'A ideia de um arquivo da vida QTIPOC em Lisboa, mantido pela comunidade: ensaios fotográficos, escrita, gravações e documentos, contribuídos e creditados por quem os criou.',
  },
  {
    slug: 'qtipoc-archive',
    column: 'body',
    from:
      'A living, community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
    to:
      'The idea behind a community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
  },
];

const INVENTED_PROSE_MARKERS: InventedProseMarker[] = [
  // "or the circle on Thursdays", a mod who "suggests one or two peers" and a
  // "short, no-pressure orientation": none of it exists in the Trans Hub.
  { slug: 'peer-support', marker: 'or the circle on Thursdays' },
  // Three pace groups of a QueerPulse running group.
  {
    slug: 'running-guide',
    marker: 'We split into three pace groups at the start.',
  },
  // The Rainbow Arts risograph, kiln, projector and bookbinding kit.
  { slug: 'shared-equipment', marker: 'All of it lives at the atelier.' },
  // A uniform meetup format with a book-swap table.
  {
    slug: 'first-meetup-guide',
    marker: "There's usually a small pile of books on the table.",
  },
  // Rainbow Arts crit sessions.
  {
    slug: 'art-crit-guide',
    marker: 'We start late on purpose so nobody is crit-ing',
  },
  // An "elders group" that keeps a practitioner list.
  {
    slug: 'lgbtq-aging-guide',
    marker: 'the elders group keeps a short list of practitioners',
  },
  // "Every gathering has an online option": events have no hybrid guarantee.
  { slug: 'spoon-theory', marker: 'Every gathering has an online option' },
];

export class RemoveInventedGuideProse1839700000000 implements MigrationInterface {
  name = 'RemoveInventedGuideProse1839700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Card copy first, so the `body = description` below copies corrected text.
    for (const swap of COPY_SWAPS) {
      await queryRunner.query(
        `UPDATE "resources" SET "${swap.column}" = $1 WHERE "slug" = $2 AND "${swap.column}" = $3`,
        [swap.to, swap.slug, swap.from],
      );
    }

    // `strpos` rather than LIKE: the markers hold no wildcard characters, but
    // this does not depend on that staying true.
    for (const { slug, marker } of INVENTED_PROSE_MARKERS) {
      await queryRunner.query(
        `UPDATE "resources"
            SET "sections" = '[]'::jsonb,
                "sections_pt" = NULL,
                "body" = "description"
          WHERE "slug" = $1
            AND strpos("sections"::text, $2) > 0`,
        [slug, marker],
      );
    }
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. Restoring the seeded sections and card copy would
    // republish prose describing groups, kits and meetup formats that do not
    // exist, which is the bug `up` fixes.
  }
}
