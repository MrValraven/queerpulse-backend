import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * CON-08 data backfill: fills `resources` and `glossary_terms`, which have
 * been EMPTY in live mode since they were created (the migration that added
 * them pointed at a seed file that was never written, and `seed.ts` inserts
 * neither). Runs after `AddResourceGuideAuthoring1794833200000`.
 *
 * Two kinds of guide row land here:
 *
 *  - Managed guides (`sections` non-empty): every word of their prose lived
 *    in the frontend i18n catalogs and is transcribed here, English and
 *    Portuguese, so `ManagedGuide` renders them from the database and an
 *    editor can change a paragraph without a deploy.
 *  - Metadata-only guides (`sections: []`): their pages carry tables,
 *    live directories, tabbed pathways, maps or modals that the generic
 *    renderer cannot hold, so the frontend keeps rendering the hardcoded
 *    page. The row still gives them a library card, an entry in the guide
 *    index, and a review date. An editor takes one of these over by adding
 *    sections in the admin editor.
 *
 * Review fields: `last_reviewed_on` and `reviewed_by` stay NULL because
 * nobody has reviewed these guides — the reader footer says exactly that
 * rather than inventing a date. `review_due_on` is set to the run date,
 * which is the truthful consequence: a never-reviewed guide is due now, and
 * the admin list sorts on it.
 *
 * Idempotent: ON CONFLICT DO NOTHING, so re-running never overwrites an
 * editor's later changes.
 */

interface BackfillGuide {
  slug: string;
  routePath: string;
  category: string;
  title: string;
  titlePt: string | null;
  description: string;
  descriptionPt: string | null;
  meta: string;
  body: string;
  sections: unknown[];
  sectionsPt: unknown[] | null;
}

interface BackfillTerm {
  slug: string;
  term: string;
  definition: string;
  definitionPt: string | null;
  category: string | null;
}

const GUIDES: BackfillGuide[] = [
  {
    slug: 'legal',
    routePath: '/safety/legal',
    category: 'legal',
    title: 'LGBTQ+ legal rights in Portugal: work, housing and health',
    titlePt: 'Direitos legais LGBTQ+ em Portugal: trabalho, habitação e saúde',
    description:
      'Know your rights at work, in housing, and in healthcare as an LGBTQ+ person in Portugal, plus a directory of vetted queer-friendly lawyers in Lisbon.',
    descriptionPt:
      'Conhece os teus direitos no trabalho, na habitação e na saúde como pessoa LGBTQ+ em Portugal, e encontra um diretório de advogados queer-friendly avaliados pela comunidade em Lisboa.',
    meta: 'Guide',
    body: 'Know your rights at work, in housing, and in healthcare as an LGBTQ+ person in Portugal, plus a directory of vetted queer-friendly lawyers in Lisbon.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'community-privacy',
    routePath: '/resources/community-privacy',
    category: 'safety',
    title: "QueerPulse privacy: what's visible, and to whom",
    titlePt: 'Privacidade no QueerPulse: o que é visível, e para quem',
    description:
      'How visibility works on QueerPulse by default: what shows on your public profile, inside the community, and to the moderation team, and how to change it.',
    descriptionPt:
      'Como funciona a visibilidade por predefinição na QueerPulse: o que aparece no teu perfil público, dentro da comunidade e para a equipa de moderação.',
    meta: 'Guide · 1 min',
    body: "What shows where\n\nThree layers, from fully public to mod-only. Most of this space lives in the bottom two.\n\nOn your public profile\n\nAlmost nothing from a low-visibility space appears here. Your membership of the coming-out space is never shown publicly, and nothing you post inside it is attached to your profile.\n\nInside the community\n\nThe member list is not shown to other members unless you choose to connect. You can read, react, and post without anyone being able to browse who else is here.\n\nOnly the mod team\n\nMods see what they need to keep the space safe, meaning reports and join requests, and nothing more. They never see your wider QueerPulse activity, and confidentiality is the first rule they hold to.\n\nYour controls\n\nReduced visibility is the default in this space. You do not have to switch anything on to be protected.\n\nYou control what is visible from your settings at any time: profile visibility, who can find you, and whether your communities are listed.\n\nLeaving a space removes you cleanly. Nothing lingers on your profile, and no notification announces it.\n\nNothing here is on your profile.\n\nAdjust your visibility any time. It's all in your settings.",
    sections: [
      {
        id: 'tiers',
        heading: 'What shows where',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Three layers, from fully public to mod-only. Most of this space lives in the bottom two.',
          },
          { kind: 'subheading', text: 'On your public profile' },
          {
            kind: 'paragraph',
            text: 'Almost nothing from a low-visibility space appears here. Your membership of the coming-out space is never shown publicly, and nothing you post inside it is attached to your profile.',
          },
          { kind: 'subheading', text: 'Inside the community' },
          {
            kind: 'paragraph',
            text: 'The member list is not shown to other members unless you choose to connect. You can read, react, and post without anyone being able to browse who else is here.',
          },
          { kind: 'subheading', text: 'Only the mod team' },
          {
            kind: 'paragraph',
            text: 'Mods see what they need to keep the space safe, meaning reports and join requests, and nothing more. They never see your wider QueerPulse activity, and confidentiality is the first rule they hold to.',
          },
        ],
      },
      {
        id: 'controls',
        heading: 'Your controls',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Reduced visibility is the default in this space. You do not have to switch anything on to be protected.',
          },
          {
            kind: 'paragraph',
            text: 'You control what is visible from your settings at any time: profile visibility, who can find you, and whether your communities are listed.',
          },
          {
            kind: 'paragraph',
            text: 'Leaving a space removes you cleanly. Nothing lingers on your profile, and no notification announces it.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Nothing here is on your profile.',
        blocks: [
          {
            kind: 'paragraph',
            text: "Adjust your visibility any time. It's all in your settings.",
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'tiers',
        heading: 'O que aparece onde',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Três camadas, do totalmente público ao só-moderação. A maior parte deste espaço vive nas duas últimas.',
          },
          { kind: 'subheading', text: 'No teu perfil público' },
          {
            kind: 'paragraph',
            text: 'Quase nada de um espaço de visibilidade reduzida aparece aqui. A tua participação no espaço de saída do armário nunca é mostrada publicamente, e nada do que publicas lá fica associado ao teu perfil.',
          },
          { kind: 'subheading', text: 'Dentro da comunidade' },
          {
            kind: 'paragraph',
            text: 'A lista de pessoas participantes não é mostrada a outras pessoas, a menos que escolhas ligar-te. Podes ler, reagir e publicar sem que ninguém consiga ver quem mais está aqui.',
          },
          { kind: 'subheading', text: 'Só a equipa de moderação' },
          {
            kind: 'paragraph',
            text: 'A moderação vê o que precisa para manter o espaço seguro, como denúncias e pedidos de entrada, e nada mais. Nunca vê a tua atividade mais alargada na QueerPulse, e a confidencialidade é a primeira regra que segue.',
          },
        ],
      },
      {
        id: 'controls',
        heading: 'Os teus controlos',
        blocks: [
          {
            kind: 'paragraph',
            text: 'A visibilidade reduzida é a predefinição neste espaço. Não precisas de ativar nada para estares protegide.',
          },
          {
            kind: 'paragraph',
            text: 'Controlas o que é visível a partir das tuas definições a qualquer momento: visibilidade do perfil, quem te consegue encontrar, e se as tuas comunidades aparecem listadas.',
          },
          {
            kind: 'paragraph',
            text: 'Sair de um espaço remove-te de forma limpa. Nada fica pendurado no teu perfil, e nenhuma notificação o anuncia.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Nada disto está no teu perfil.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Ajusta a tua visibilidade quando quiseres. Está tudo nas tuas definições.',
          },
        ],
      },
    ],
  },
  {
    slug: 'safety',
    routePath: '/safety',
    category: 'safety',
    title: 'How QueerPulse protects your privacy and safety',
    titlePt: 'Como a QueerPulse protege a tua privacidade e segurança',
    description:
      'How visibility levels, vouching, and data protection work on QueerPulse, plus how to report a concern and what happens if you decide to leave.',
    descriptionPt:
      'Como funcionam os níveis de visibilidade, o sistema de votos de confiança e a proteção de dados na QueerPulse, e como denunciar uma preocupação ou sair da rede.',
    meta: 'Guide',
    body: 'How visibility levels, vouching, and data protection work on QueerPulse, plus how to report a concern and what happens if you decide to leave.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'queer-101',
    routePath: '/resources/101',
    category: 'community',
    title: 'Queer 101: a no-pressure LGBTQ+ starter guide',
    titlePt: 'Queer 101: um guia introdutório LGBTQ+, sem pressão',
    description:
      'For anyone newly exploring their identity: common questions answered, key terms explained, and low-pressure ways to talk to someone, no account required.',
    descriptionPt:
      'Para quem está a explorar a identidade pela primeira vez: perguntas frequentes respondidas, termos explicados, e formas de falar com alguém, sem precisar de conta.',
    meta: 'Guide',
    body: 'For anyone newly exploring their identity: common questions answered, key terms explained, and low-pressure ways to talk to someone, no account required.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'pronouns-guide',
    routePath: '/resources/pronouns-guide',
    category: 'community',
    title: 'Pronouns and chosen name on QueerPulse: a practical guide',
    titlePt: 'Pronomes e nome escolhido na QueerPulse: guia prático',
    description:
      'How QueerPulse handles chosen names and pronouns across the platform, plus answers on deadnames, name changes, privacy, and legal name data.',
    descriptionPt:
      'Como a QueerPulse trata nomes escolhidos e pronomes em toda a plataforma, com respostas sobre deadname, mudança de nome, privacidade e dados de nome legal.',
    meta: 'Guide',
    body: 'How QueerPulse handles chosen names and pronouns across the platform, plus answers on deadnames, name changes, privacy, and legal name data.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'mental-health',
    routePath: '/resources/mental-health',
    category: 'health',
    title: 'Queer-affirming mental health support in Lisbon',
    titlePt: 'Apoio em saúde mental afirmativo para pessoas queer em Lisboa',
    description:
      'Queer-affirming therapists in Lisbon, crisis lines for immediate support, and a practical guide to accessing mental health care through the SNS.',
    descriptionPt:
      'Terapeutas afirmativos em Lisboa, linhas de apoio para emergências, e um guia prático para aceder a cuidados de saúde mental através do SNS.',
    meta: 'Guide',
    body: 'Queer-affirming therapists in Lisbon, crisis lines for immediate support, and a practical guide to accessing mental health care through the SNS.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'wellbeing',
    routePath: '/resources/wellbeing',
    category: 'health',
    title: 'LGBTQ+ wellbeing in Lisbon: therapists, peers, crisis help',
    titlePt: 'Bem-estar LGBTQ+ em Lisboa: terapeutas, pares e apoio em crise',
    description:
      'Wellbeing resources built by and for the community: a vetted therapist directory, peer support, crisis contacts, and harm reduction, all in one place.',
    descriptionPt:
      'Recursos de bem-estar feitos pela e para a comunidade: diretório de terapeutas verificado, apoio entre pares, contactos de emergência e redução de danos, tudo num só lugar.',
    meta: 'Guide',
    body: 'Wellbeing resources built by and for the community: a vetted therapist directory, peer support, crisis contacts, and harm reduction, all in one place.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'trans-hub',
    routePath: '/resources/trans-hub',
    category: 'trans',
    title: 'Trans & non-binary hub: healthcare, legal, and community',
    titlePt: 'Hub trans e não-binárie: saúde, questões legais e comunidade',
    description:
      'A dedicated hub for trans and non-binary members: healthcare navigation, legal and admin guides, peer support, and community, built specifically for you.',
    descriptionPt:
      'Um espaço dedicado a pessoas trans e não-binárias: orientação em saúde, guias jurídicos e administrativos, apoio entre pares e comunidade, feito especificamente para ti.',
    meta: 'Guide',
    body: 'A dedicated hub for trans and non-binary members: healthcare navigation, legal and admin guides, peer support, and community, built specifically for you.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'trans-healthcare',
    routePath: '/resources/trans-healthcare',
    category: 'trans',
    title:
      'Trans healthcare in Lisbon: clinics, name changes and where to start',
    titlePt:
      'Saúde trans em Lisboa: clínicas, mudança de nome e por onde começar',
    description:
      'A practical guide to trans healthcare in Portugal: SNS and private HRT pathways, legal name and gender marker changes, and affirming clinicians in Lisbon.',
    descriptionPt:
      'Um guia prático de saúde trans em Portugal: hormonoterapia no SNS e no privado, mudança legal de nome e de menção de sexo, e clínicos afirmativos em Lisboa.',
    meta: 'Guide',
    body: 'A practical guide to trans healthcare in Portugal: SNS and private HRT pathways, legal name and gender marker changes, and affirming clinicians in Lisbon.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'harm-reduction',
    routePath: '/resources/harm-reduction',
    category: 'health',
    title: 'Harm reduction in Lisbon: safer partying, no judgment',
    titlePt: 'Redução de danos em Lisboa: sair com mais segurança',
    description:
      'Non-judgmental harm-reduction guidance for nightlife in Lisbon: naloxone and overdose response, safer use, comedowns, chemsex, and where to get tested.',
    descriptionPt:
      'Informação sem julgamento sobre redução de danos para noites em Lisboa: naloxona e resposta a overdose, consumo mais seguro, quebras, chemsex e testes.',
    meta: 'Guide',
    body: 'Non-judgmental harm-reduction guidance for nightlife in Lisbon: naloxone and overdose response, safer use, comedowns, chemsex, and where to get tested.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'sober',
    routePath: '/resources/sober',
    category: 'health',
    title: 'Sober and queer in Lisbon: alcohol-free events and venues',
    titlePt: 'Sóbrie e queer em Lisboa: eventos e espaços sem álcool',
    description:
      "A full queer social life without alcohol: sober and alcohol-free events in Lisbon, venues that don't centre the bar, and peer support for recovery or sober-curious members.",
    descriptionPt:
      'Uma vida social queer plena sem álcool: eventos e espaços em Lisboa para lá do bar, e apoio entre pares para quem está em recuperação, a explorar a sobriedade, ou simplesmente não bebe.',
    meta: 'Guide',
    body: "A full queer social life without alcohol: sober and alcohol-free events in Lisbon, venues that don't centre the bar, and peer support for recovery or sober-curious members.",
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'sexual-health',
    routePath: '/resources/sexual-health',
    category: 'health',
    title: 'Sexual health in Lisbon: testing, PrEP and HIV resources',
    titlePt: 'Saúde sexual em Lisboa: testes, PrEP e recursos sobre VIH',
    description:
      'A practical guide to sexual health in Lisbon: where to get tested, how to access free PrEP through the SNS, HIV resources and U=U, and a community-reviewed clinic directory.',
    descriptionPt:
      'Um guia prático de saúde sexual em Lisboa: onde fazer testes, como aceder à PrEP gratuita pelo SNS, recursos sobre VIH e I=I, e um diretório de clínicas avaliado pela comunidade.',
    meta: 'Guide',
    body: 'A practical guide to sexual health in Lisbon: where to get tested, how to access free PrEP through the SNS, HIV resources and U=U, and a community-reviewed clinic directory.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'micro-grants',
    routePath: '/work/grants/micro',
    category: 'finance',
    title: 'micro-grants',
    titlePt: null,
    description:
      'Micro-grants of €200–2000 for queer community projects in Lisbon. Funded by members, allocated by members, reported back to members. No gatekeepers.',
    descriptionPt:
      'Microbolsas de 200–2000 € para projetos comunitários queer em Lisboa. Financiadas pela comunidade, atribuídas pela comunidade, com prestação de contas à comunidade. Sem gatekeepers.',
    meta: 'Guide',
    body: 'Micro-grants of €200–2000 for queer community projects in Lisbon. Funded by members, allocated by members, reported back to members. No gatekeepers.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'peer-support',
    routePath: '/resources/peer-support',
    category: 'health',
    title: 'Peer support for trans people in Lisbon: how it works',
    titlePt: 'Apoio entre pares para pessoas trans em Lisboa: como funciona',
    description:
      "Peer support in QueerPulse's Trans Hub. Not therapy, not advice, just someone who's been where you are. How to ask for support or become a peer yourself.",
    descriptionPt:
      'Apoio entre pares no Trans Hub da QueerPulse: alguém que já passou pelo que estás a viver. Como pedir apoio ou tornares-te numa pessoa de apoio.',
    meta: 'Guide · 1 min',
    body: "What peer support is\n\nPeer support is not therapy and it is not advice. It is sitting with someone who has been where you are and does not need it explained. No clinical notes, no diagnosis, no goal you have to reach by the end.\n\nIn the Hub, peer support runs two ways: the open circle where the group shows up together, and one-to-one pairing when you want a single person to talk to over time. You choose which, and you can switch whenever.\n\nHow it works\n\nFour steps, none of them binding. You stay in control of every one.\n\nTell us what you need\n\nPost in the Hub or message a mod. You can be as specific or as vague as you like: 'I just started HRT and want someone who gets it' is plenty to go on.\n\nWe pair you, gently\n\nA mod suggests one or two peers whose experience overlaps with yours. Nothing is automatic and nobody sees your request but the mod team. You say yes or not-yet.\n\nYou set the shape\n\nCoffee, a walk, a voice note once a week, or the circle on Thursdays, whatever is sustainable for both of you. There is no minimum commitment and no awkwardness in stopping.\n\nYou can become a peer too\n\nMost people who are supported end up supporting someone else later. When you are ready, tell a mod. We run a short, no-pressure orientation on holding space and keeping confidentiality.\n\nYou don't have to carry it alone.\n\nThe Hub is here, and so is the wider community forum.",
    sections: [
      {
        id: 'what',
        heading: 'What peer support is',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Peer support is not therapy and it is not advice. It is sitting with someone who has been where you are and does not need it explained. No clinical notes, no diagnosis, no goal you have to reach by the end.',
          },
          {
            kind: 'paragraph',
            text: 'In the Hub, peer support runs two ways: the open circle where the group shows up together, and one-to-one pairing when you want a single person to talk to over time. You choose which, and you can switch whenever.',
          },
        ],
      },
      {
        id: 'how',
        heading: 'How it works',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Four steps, none of them binding. You stay in control of every one.',
          },
          { kind: 'subheading', text: 'Tell us what you need' },
          {
            kind: 'paragraph',
            text: "Post in the Hub or message a mod. You can be as specific or as vague as you like: 'I just started HRT and want someone who gets it' is plenty to go on.",
          },
          { kind: 'subheading', text: 'We pair you, gently' },
          {
            kind: 'paragraph',
            text: 'A mod suggests one or two peers whose experience overlaps with yours. Nothing is automatic and nobody sees your request but the mod team. You say yes or not-yet.',
          },
          { kind: 'subheading', text: 'You set the shape' },
          {
            kind: 'paragraph',
            text: 'Coffee, a walk, a voice note once a week, or the circle on Thursdays, whatever is sustainable for both of you. There is no minimum commitment and no awkwardness in stopping.',
          },
          { kind: 'subheading', text: 'You can become a peer too' },
          {
            kind: 'paragraph',
            text: 'Most people who are supported end up supporting someone else later. When you are ready, tell a mod. We run a short, no-pressure orientation on holding space and keeping confidentiality.',
          },
        ],
      },
      {
        id: 'outro',
        heading: "You don't have to carry it alone.",
        blocks: [
          {
            kind: 'paragraph',
            text: 'The Hub is here, and so is the wider community forum.',
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'what',
        heading: 'O que é o apoio entre pares',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Apoio entre pares não é terapia nem é aconselhamento. É estar com alguém que já passou pelo que estás a passar e que não precisa que lhe expliques tudo. Sem notas clínicas, sem diagnóstico, sem objetivo que tenhas de atingir no fim.',
          },
          {
            kind: 'paragraph',
            text: 'No Hub, o apoio entre pares funciona de duas formas: o círculo aberto onde o grupo aparece em conjunto, e o emparelhamento um-para-um quando queres falar sempre com a mesma pessoa ao longo do tempo. Tu escolhes qual, e podes mudar quando quiseres.',
          },
        ],
      },
      {
        id: 'how',
        heading: 'Como funciona',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Quatro passos, nenhum deles vinculativo. Mantés o controlo em todos eles.',
          },
          { kind: 'subheading', text: 'Diz-nos o que precisas' },
          {
            kind: 'paragraph',
            text: "Publica no Hub ou envia mensagem a uma pessoa moderadora. Podes ser tão específico ou vago quanto quiseres: 'Comecei HRT agora e quero alguém que perceba' já chega.",
          },
          { kind: 'subheading', text: 'Emparelhamos-te, com cuidado' },
          {
            kind: 'paragraph',
            text: 'Uma pessoa moderadora sugere uma ou duas pessoas cuja experiência se cruza com a tua. Nada é automático e ninguém vê o teu pedido além da equipa de moderação. Dizes que sim ou ainda não.',
          },
          { kind: 'subheading', text: 'Tu defines o formato' },
          {
            kind: 'paragraph',
            text: 'Um café, uma caminhada, uma nota de voz uma vez por semana, ou o círculo às quintas-feiras: o que for sustentável para os dois. Não há compromisso mínimo nem estranheza em parar.',
          },
          {
            kind: 'subheading',
            text: 'Também podes tornar-te uma pessoa de apoio',
          },
          {
            kind: 'paragraph',
            text: 'A maioria das pessoas que recebem apoio acaba por apoiar outra pessoa mais tarde. Quando estiveres pronte, diz a uma pessoa moderadora. Fazemos uma orientação curta e sem pressão sobre como acolher espaço e manter a confidencialidade.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Não tens de carregar isto sozinho.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'O Hub está aqui, e o fórum mais alargado da comunidade também.',
          },
        ],
      },
    ],
  },
  {
    slug: 'accessible-lisbon',
    routePath: '/resources/accessible-lisbon',
    category: 'community',
    title: 'Accessible Lisbon: step-free routes and low-sensory spots',
    titlePt: 'Lisboa acessível: percursos sem degraus e espaços calmos',
    description:
      "Peer-verified accessible Lisbon: step-free walking routes, low-sensory bars and cafés, and family-friendly parks, each checked by someone who's been there.",
    descriptionPt:
      'Lisboa acessível verificada pela comunidade: percursos sem degraus, bares e cafés de baixo estímulo sensorial, e parques para famílias, testados por quem lá esteve.',
    meta: 'Guide',
    body: "Peer-verified accessible Lisbon: step-free walking routes, low-sensory bars and cafés, and family-friendly parks, each checked by someone who's been there.",
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'art-crit-guide',
    routePath: '/resources/art-crit-guide',
    category: 'culture',
    title: 'How Rainbow Arts crit sessions work',
    titlePt: 'Como funcionam as críticas de grupo da Artes Arco-Íris',
    description:
      'How Rainbow Arts group critiques work: the honest, kind, specific method, the four-step flow, and examples of useful versus unhelpful feedback.',
    descriptionPt:
      'Como funcionam as sessões de crítica de grupo da Artes Arco-Íris: o método honesto, gentil e específico, os quatro passos, e exemplos de feedback útil.',
    meta: 'Guide · 1 min',
    body: 'The principle\n\nHonest, kind, specific, in that order. Vague praise helps no one and cruelty dressed as honesty is just cruelty. We critique the work in front of us, never the CV behind it and never the person who made it.\n\nHow a session runs\n\nArrival to coffee, in four moves.\n\nArrive and settle\n\nCoffee first. We start late on purpose so nobody is crit-ing before they have taken their coat off. Bring one work, finished or not.\n\nThe maker frames it\n\nYou get two minutes to say what it is and, if you want, what you are stuck on. You can also say nothing and let the work speak. Both are allowed.\n\nThe room responds\n\nWe go round. Specific observations, then questions, then suggestions if invited. We talk about what is on the wall, not what we would have made instead.\n\nThe maker keeps what fits\n\nYou are never obliged to agree. Take what is useful, leave the rest, and we move to the next work. Long table and food after.\n\nWhat to say\n\nSpecific beats nice. Here\'s the difference, in the room\'s own words.\n\n"The coral reads as the focal point but the eye keeps getting pulled to the bottom-left corner. Is that intended?"\n\n"The half-finished edge feels alive; finishing it might kill the tension you have got here."\n\n"What were you trying to do with the negative space? It might be doing more than you think."\n\nBring one work.\n\nFinished or not: half-finished is exactly what a crit is for. Find the next open crit on the board.',
    sections: [
      {
        id: 'principle',
        heading: 'The principle',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Honest, kind, specific, in that order. Vague praise helps no one and cruelty dressed as honesty is just cruelty. We critique the work in front of us, never the CV behind it and never the person who made it.',
          },
        ],
      },
      {
        id: 'flow',
        heading: 'How a session runs',
        blocks: [
          { kind: 'paragraph', text: 'Arrival to coffee, in four moves.' },
          { kind: 'subheading', text: 'Arrive and settle' },
          {
            kind: 'paragraph',
            text: 'Coffee first. We start late on purpose so nobody is crit-ing before they have taken their coat off. Bring one work, finished or not.',
          },
          { kind: 'subheading', text: 'The maker frames it' },
          {
            kind: 'paragraph',
            text: 'You get two minutes to say what it is and, if you want, what you are stuck on. You can also say nothing and let the work speak. Both are allowed.',
          },
          { kind: 'subheading', text: 'The room responds' },
          {
            kind: 'paragraph',
            text: 'We go round. Specific observations, then questions, then suggestions if invited. We talk about what is on the wall, not what we would have made instead.',
          },
          { kind: 'subheading', text: 'The maker keeps what fits' },
          {
            kind: 'paragraph',
            text: 'You are never obliged to agree. Take what is useful, leave the rest, and we move to the next work. Long table and food after.',
          },
        ],
      },
      {
        id: 'examples',
        heading: 'What to say',
        blocks: [
          {
            kind: 'paragraph',
            text: "Specific beats nice. Here's the difference, in the room's own words.",
          },
          {
            kind: 'paragraph',
            text: '"The coral reads as the focal point but the eye keeps getting pulled to the bottom-left corner. Is that intended?"',
          },
          {
            kind: 'paragraph',
            text: '"The half-finished edge feels alive; finishing it might kill the tension you have got here."',
          },
          {
            kind: 'paragraph',
            text: '"What were you trying to do with the negative space? It might be doing more than you think."',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Bring one work.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Finished or not: half-finished is exactly what a crit is for. Find the next open crit on the board.',
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'principle',
        heading: 'O princípio',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Honesto, gentil, específico, por esta ordem. Elogio vago não ajuda ninguém e crueldade disfarçada de honestidade é só crueldade. Criticamos o trabalho que está à nossa frente, nunca o currículo por trás dele nem a pessoa que o fez.',
          },
        ],
      },
      {
        id: 'flow',
        heading: 'Como decorre uma sessão',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Da chegada ao café, em quatro momentos.',
          },
          { kind: 'subheading', text: 'Chegar e instalar-te' },
          {
            kind: 'paragraph',
            text: 'Café primeiro. Começamos tarde de propósito para que ninguém esteja a criticar antes de tirar o casaco. Traz um trabalho, acabado ou não.',
          },
          { kind: 'subheading', text: 'Quem fez enquadra o trabalho' },
          {
            kind: 'paragraph',
            text: 'Tens dois minutos para dizer o que é e, se quiseres, em que estás preso. Também podes não dizer nada e deixar o trabalho falar. Ambos são permitidos.',
          },
          { kind: 'subheading', text: 'A sala responde' },
          {
            kind: 'paragraph',
            text: 'Vamos dando a volta. Observações específicas, depois perguntas, depois sugestões se convidadas. Falamos do que está na parede, não do que teríamos feito em vez disso.',
          },
          { kind: 'subheading', text: 'Quem fez fica com o que serve' },
          {
            kind: 'paragraph',
            text: 'Nunca és obrigade a concordar. Fica com o que é útil, deixa o resto, e passamos ao próximo trabalho. Mesa comprida e comida a seguir.',
          },
        ],
      },
      {
        id: 'examples',
        heading: 'O que dizer',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Específico vence simpático. Aqui está a diferença, nas próprias palavras da sala.',
          },
          {
            kind: 'paragraph',
            text: '"O coral lê-se como o ponto focal mas o olhar continua a ser puxado para o canto inferior esquerdo. É intencional?"',
          },
          {
            kind: 'paragraph',
            text: '"O bordo por acabar parece vivo; terminá-lo pode matar a tensão que aqui tens."',
          },
          {
            kind: 'paragraph',
            text: '"O que estavas a tentar fazer com o espaço negativo? Pode estar a fazer mais do que pensas."',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Traz um trabalho.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Acabado ou não, meio acabado é exatamente para que serve uma crítica. Encontra a próxima crítica aberta no quadro.',
          },
        ],
      },
    ],
  },
  {
    slug: 'coming-out-at-work',
    routePath: '/resources/coming-out-at-work',
    category: 'community',
    title: 'Coming out at work: timing, scripts and your rights',
    titlePt: 'Sair do armário no trabalho: timing, frases e direitos',
    description:
      'A practical guide to coming out at work in Portugal: reading the room, sample scripts for telling colleagues, and what to do if it goes badly.',
    descriptionPt:
      'Um guia prático para sair do armário no trabalho em Portugal: como ler o ambiente, frases para colegas, e o que fazer se correr mal.',
    meta: 'Guide',
    body: 'A practical guide to coming out at work in Portugal: reading the room, sample scripts for telling colleagues, and what to do if it goes badly.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'disability-healthcare',
    routePath: '/resources/disability-healthcare',
    category: 'health',
    title: 'Disability and chronic illness care in Portugal',
    titlePt: 'Deficiência e doença crónica: saúde em Portugal',
    description:
      'A practical guide to navigating Portuguese healthcare with a disability or chronic condition: accommodations, referrals, accessible GPs, and insurance.',
    descriptionPt:
      'Um guia prático para navegar a saúde portuguesa com deficiência ou doença crónica: adaptações, referenciações, médicos de família acessíveis e seguros.',
    meta: 'Guide',
    body: 'A practical guide to navigating Portuguese healthcare with a disability or chronic condition: accommodations, referrals, accessible GPs, and insurance.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'first-meetup-guide',
    routePath: '/resources/first-meetup-guide',
    category: 'community',
    title: 'Your first QueerPulse meetup: what to expect',
    titlePt: 'O teu primeiro encontro QueerPulse: o que esperar',
    description:
      "What actually happens at a first in-person meetup, what 'no agenda' really means, and honest answers to the questions newcomers are too nervous to ask.",
    descriptionPt:
      "O que acontece de facto num primeiro encontro presencial, o que 'sem agenda' significa na prática, e respostas às perguntas que quem chega tem medo de fazer.",
    meta: 'Guide · 2 min',
    body: "What to expect\n\nThe whole format, so none of it is a surprise.\n\nNo agenda, no pitch\n\nNobody is going to ask what you do for work or try to recruit you for anything. The whole format is: show up, talk to whoever you end up next to, leave when you like.\n\nThe book-swap table\n\nThere's usually a small pile of books on the table. Bring one, take one, or just use it as something to do with your hands for the first ten minutes. It works.\n\nCome alone or bring someone\n\nMost people come alone the first time. You'll be looked after. If it helps to bring a friend, bring a friend. Both are completely normal.\n\nWhat \"no agenda\" means\n\nFour things we hold to, so the room stays easy for everyone in it.\n\nYou don't need to be out, or out in any particular way, to be here.\n\nAsk before taking photos, always, of everyone.\n\nWe look after first-timers; we were all one once.\n\nWhat's shared in person stays in person.\n\nThe nervous questions\n\nWhat if I don't know anyone?\n\nNobody does, the first time. The host is there early specifically to catch people at the door and introduce you. Say you're new: it's the easiest sentence to say here.\n\nWhat if I'm really nervous?\n\nAlmost everyone is, and almost everyone almost turns around at the door. The people setting up tables this month did exactly that at their first one. It gets easy fast.\n\nHow will I find the group?\n\nThe host posts where they'll be and what they're wearing, usually at a specific entrance or lift at a set time, then everyone moves together. Check the gathering's pinned post.\n\nDo I have to stay the whole time?\n\nNo. Leave whenever you like, no explanation needed. Staying twenty minutes still counts as coming.\n\nJust show up.\n\nThat's the whole entry requirement. The next meetup is on the board.",
    sections: [
      {
        id: 'expect',
        heading: 'What to expect',
        blocks: [
          {
            kind: 'paragraph',
            text: 'The whole format, so none of it is a surprise.',
          },
          { kind: 'subheading', text: 'No agenda, no pitch' },
          {
            kind: 'paragraph',
            text: 'Nobody is going to ask what you do for work or try to recruit you for anything. The whole format is: show up, talk to whoever you end up next to, leave when you like.',
          },
          { kind: 'subheading', text: 'The book-swap table' },
          {
            kind: 'paragraph',
            text: "There's usually a small pile of books on the table. Bring one, take one, or just use it as something to do with your hands for the first ten minutes. It works.",
          },
          { kind: 'subheading', text: 'Come alone or bring someone' },
          {
            kind: 'paragraph',
            text: "Most people come alone the first time. You'll be looked after. If it helps to bring a friend, bring a friend. Both are completely normal.",
          },
        ],
      },
      {
        id: 'values',
        heading: 'What "no agenda" means',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Four things we hold to, so the room stays easy for everyone in it.',
          },
          {
            kind: 'listItem',
            text: "You don't need to be out, or out in any particular way, to be here.",
          },
          {
            kind: 'listItem',
            text: 'Ask before taking photos, always, of everyone.',
          },
          {
            kind: 'listItem',
            text: 'We look after first-timers; we were all one once.',
          },
          {
            kind: 'listItem',
            text: "What's shared in person stays in person.",
          },
        ],
      },
      {
        id: 'faq',
        heading: 'The nervous questions',
        blocks: [
          { kind: 'subheading', text: "What if I don't know anyone?" },
          {
            kind: 'paragraph',
            text: "Nobody does, the first time. The host is there early specifically to catch people at the door and introduce you. Say you're new: it's the easiest sentence to say here.",
          },
          { kind: 'subheading', text: "What if I'm really nervous?" },
          {
            kind: 'paragraph',
            text: 'Almost everyone is, and almost everyone almost turns around at the door. The people setting up tables this month did exactly that at their first one. It gets easy fast.',
          },
          { kind: 'subheading', text: 'How will I find the group?' },
          {
            kind: 'paragraph',
            text: "The host posts where they'll be and what they're wearing, usually at a specific entrance or lift at a set time, then everyone moves together. Check the gathering's pinned post.",
          },
          { kind: 'subheading', text: 'Do I have to stay the whole time?' },
          {
            kind: 'paragraph',
            text: 'No. Leave whenever you like, no explanation needed. Staying twenty minutes still counts as coming.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Just show up.',
        blocks: [
          {
            kind: 'paragraph',
            text: "That's the whole entry requirement. The next meetup is on the board.",
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'expect',
        heading: 'O que esperar',
        blocks: [
          {
            kind: 'paragraph',
            text: 'O formato todo, para que nada seja surpresa.',
          },
          { kind: 'subheading', text: 'Sem agenda, sem proposta' },
          {
            kind: 'paragraph',
            text: 'Ninguém te vai perguntar o que fazes profissionalmente nem tentar recrutar-te para nada. O formato é este: aparece, fala com quem calhar ao teu lado, sai quando quiseres.',
          },
          { kind: 'subheading', text: 'A mesa de troca de livros' },
          {
            kind: 'paragraph',
            text: 'Normalmente há uma pequena pilha de livros na mesa. Traz um, leva um, ou usa-a só para teres algo que fazer com as mãos nos primeiros dez minutos. Funciona.',
          },
          { kind: 'subheading', text: 'Vem sozinho ou traz alguém' },
          {
            kind: 'paragraph',
            text: 'A maioria das pessoas vem sozinha da primeira vez. Vais ser bem cuidade. Se ajudar trazer une amigue, traz une amigue: ambos são completamente normais.',
          },
        ],
      },
      {
        id: 'values',
        heading: 'O que "sem agenda" significa',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Quatro coisas a que nos mantemos fiéis, para que a sala continue fácil para todes.',
          },
          {
            kind: 'listItem',
            text: 'Não precisas de estar fora do armário, ou fora de uma forma específica, para estares aqui.',
          },
          {
            kind: 'listItem',
            text: 'Pede sempre autorização antes de tirar fotografias, de todes.',
          },
          {
            kind: 'listItem',
            text: 'Cuidamos de quem vem pela primeira vez; todes já fomos isso um dia.',
          },
          {
            kind: 'listItem',
            text: 'O que se partilha presencialmente fica presencialmente.',
          },
        ],
      },
      {
        id: 'faq',
        heading: 'As perguntas nervosas',
        blocks: [
          { kind: 'subheading', text: 'E se eu não conhecer ninguém?' },
          {
            kind: 'paragraph',
            text: 'Ninguém conhece, da primeira vez. A pessoa anfitriã chega cedo especificamente para receber as pessoas à porta e apresentar-te. Diz que és nove por aqui: é a frase mais fácil de dizer aqui.',
          },
          { kind: 'subheading', text: 'E se eu estiver mesmo nervoso/a?' },
          {
            kind: 'paragraph',
            text: 'Quase todes estão, e quase todes quase dão meia-volta à porta. As pessoas que estão a preparar as mesas este mês fizeram exatamente isso no primeiro encontro delas. Fica fácil depressa.',
          },
          { kind: 'subheading', text: 'Como vou encontrar o grupo?' },
          {
            kind: 'paragraph',
            text: 'A pessoa anfitriã publica onde vai estar e o que vai vestir, normalmente numa entrada ou elevador específico, a uma hora marcada, e depois todes seguem juntes. Vê a publicação fixada do encontro.',
          },
          { kind: 'subheading', text: 'Tenho de ficar o tempo todo?' },
          {
            kind: 'paragraph',
            text: 'Não. Sai quando quiseres, sem precisares de explicar. Ficar vinte minutos também conta como teres vindo.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Basta aparecer.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'É esse o único requisito de entrada. O próximo encontro está no quadro.',
          },
        ],
      },
    ],
  },
  {
    slug: 'group-show-archive',
    routePath: '/resources/group-show-archive',
    category: 'culture',
    title: 'Rainbow Arts: an archive of every group show',
    titlePt: 'Artes Arco-Íris: arquivo de todas as exposições',
    description:
      'An archive of every Rainbow Arts group show, with dates, venues, and what was made, from the first pop-up to the most recent weekend residency.',
    descriptionPt:
      'Um arquivo de todas as exposições de grupo da Artes Arco-Íris: datas, locais e o que foi feito, desde o primeiro pop-up até à residência mais recente.',
    meta: 'Guide',
    body: 'An archive of every Rainbow Arts group show, with dates, venues, and what was made, from the first pop-up to the most recent weekend residency.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'ingredients-map',
    routePath: '/resources/ingredients-map',
    category: 'culture',
    title: 'Where to find ingredients from home in Lisbon',
    titlePt: 'Onde encontrar ingredientes de casa em Lisboa',
    description:
      'A community-mapped guide to Lisbon grocers, markets, and stalls carrying ingredients from home, organised by neighbourhood, from Mouraria to Marvila.',
    descriptionPt:
      'Um mapa feito pela comunidade de mercearias, mercados e bancas em Lisboa com ingredientes de casa, organizado por bairro, da Mouraria a Marvila.',
    meta: 'Guide',
    body: 'A community-mapped guide to Lisbon grocers, markets, and stalls carrying ingredients from home, organised by neighbourhood, from Mouraria to Marvila.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'lgbtq-aging-guide',
    routePath: '/resources/lgbtq-aging-guide',
    category: 'community',
    title: 'LGBTQ+ aging in Portugal: healthcare after 50',
    titlePt: 'Envelhecer LGBTQ+ em Portugal: saúde a partir dos 50',
    description:
      'Navigating Portuguese healthcare as an LGBTQ+ person over 50: finding affirming GPs and hospitals, care options, and mental health support.',
    descriptionPt:
      'Navegar a saúde portuguesa como pessoa LGBTQ+ com mais de 50 anos: encontrar médicos e hospitais afirmativos, opções de cuidados e apoio em saúde mental.',
    meta: 'Guide · 1 min',
    body: "The essentials\n\nPlain, practical, and written by the group that uses it. Recently translated into Portuguese.\n\nFinding a GP who doesn't make it weird\n\nYou are allowed to ask a Centro de Saúde to note your pronouns and partner, and to switch GP if one is dismissive. Bring a written summary of your history so you are not explaining your life from scratch each visit.\n\nHospitals and specialist referrals\n\nNext-of-kin assumptions still trip up same-sex partners in hospital settings. A simple signed document naming your partner as your contact and decision-maker prevents most problems before they start.\n\nElder care and housing\n\nAsk any care facility directly about their experience with LGBTQ+ residents and same-sex couples. The good ones answer plainly; the answer itself tells you most of what you need to know.\n\nMental health in later life\n\nIsolation and a lifetime of guardedness take a toll. Affirming therapy exists at every age, and the elders group keeps a short list of practitioners who understand the particular history you carry.\n\nUseful links\n\nSupport, legal help, and community programmes including for older LGBTQ+ people.\n\n808 24 24 24 · 24h national health line for triage and advice.\n\nLater life, well held.\n\nIf what you need is someone to talk to, the mental health directory is affirming at every age.",
    sections: [
      {
        id: 'topics',
        heading: 'The essentials',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Plain, practical, and written by the group that uses it. Recently translated into Portuguese.',
          },
          {
            kind: 'subheading',
            text: "Finding a GP who doesn't make it weird",
          },
          {
            kind: 'paragraph',
            text: 'You are allowed to ask a Centro de Saúde to note your pronouns and partner, and to switch GP if one is dismissive. Bring a written summary of your history so you are not explaining your life from scratch each visit.',
          },
          { kind: 'subheading', text: 'Hospitals and specialist referrals' },
          {
            kind: 'paragraph',
            text: 'Next-of-kin assumptions still trip up same-sex partners in hospital settings. A simple signed document naming your partner as your contact and decision-maker prevents most problems before they start.',
          },
          { kind: 'subheading', text: 'Elder care and housing' },
          {
            kind: 'paragraph',
            text: 'Ask any care facility directly about their experience with LGBTQ+ residents and same-sex couples. The good ones answer plainly; the answer itself tells you most of what you need to know.',
          },
          { kind: 'subheading', text: 'Mental health in later life' },
          {
            kind: 'paragraph',
            text: 'Isolation and a lifetime of guardedness take a toll. Affirming therapy exists at every age, and the elders group keeps a short list of practitioners who understand the particular history you carry.',
          },
        ],
      },
      {
        id: 'links',
        heading: 'Useful links',
        blocks: [
          {
            kind: 'note',
            text: 'Support, legal help, and community programmes including for older LGBTQ+ people.',
          },
          {
            kind: 'note',
            text: '808 24 24 24 · 24h national health line for triage and advice.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Later life, well held.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'If what you need is someone to talk to, the mental health directory is affirming at every age.',
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'topics',
        heading: 'O essencial',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Simples, prático, e escrito pelo grupo que o usa. Recentemente traduzido para português.',
          },
          {
            kind: 'subheading',
            text: 'Encontrar um médico de família que não torne isto estranho',
          },
          {
            kind: 'paragraph',
            text: 'Podes pedir a um Centro de Saúde que registe os teus pronomes e a tua parceria, e mudar de médico se um deles for desdenhoso. Traz um resumo escrito do teu historial para não teres de explicar a tua vida do zero em cada consulta.',
          },
          {
            kind: 'subheading',
            text: 'Hospitais e referenciações para especialistas',
          },
          {
            kind: 'paragraph',
            text: 'As suposições sobre familiares mais próximos ainda complicam parcerias do mesmo sexo em contexto hospitalar. Um simples documento assinado nomeando a tua parceria como contacto e decisora evita a maioria dos problemas antes de começarem.',
          },
          { kind: 'subheading', text: 'Cuidados a idosos e habitação' },
          {
            kind: 'paragraph',
            text: 'Pergunta diretamente a qualquer instituição de cuidados sobre a experiência que têm com residentes LGBTQ+ e casais do mesmo sexo. As boas respondem sem rodeios; a própria resposta diz-te quase tudo o que precisas de saber.',
          },
          { kind: 'subheading', text: 'Saúde mental em idade avançada' },
          {
            kind: 'paragraph',
            text: 'O isolamento e toda uma vida de cautela cobram o seu preço. Existe terapia afirmativa a qualquer idade, e o grupo de pessoas idosas mantém uma pequena lista de profissionais que compreendem a história particular que carregas.',
          },
        ],
      },
      {
        id: 'links',
        heading: 'Ligações úteis',
        blocks: [
          {
            kind: 'note',
            text: 'Apoio, ajuda jurídica, e programas comunitários, incluindo para pessoas LGBTQ+ mais velhas.',
          },
          {
            kind: 'note',
            text: '808 24 24 24 · linha nacional de saúde 24h para triagem e aconselhamento.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'A vida mais tarde, bem acompanhada.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Se o que precisas é falar com alguém, o diretório de saúde mental é afirmativo a qualquer idade.',
          },
        ],
      },
    ],
  },
  {
    slug: 'oral-history-project',
    routePath: '/resources/oral-history-project',
    category: 'culture',
    title: 'LGBTQ+ oral history project in Lisbon: share your story',
    titlePt: 'Projeto de histórias orais LGBTQ+ em Lisboa: participa',
    description:
      'QueerPulse is recording the lives of LGBTQ+ elders in Lisbon, voice-only if you prefer, no faces required, and entirely on your own terms.',
    descriptionPt:
      'Estamos a gravar as vidas de pessoas LGBTQ+ mais velhas em Lisboa: só voz, se preferires, sem necessidade de rosto, e sempre nos teus termos.',
    meta: 'Guide',
    body: 'QueerPulse is recording the lives of LGBTQ+ elders in Lisbon, voice-only if you prefer, no faces required, and entirely on your own terms.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'qtipoc-archive',
    routePath: '/resources/qtipoc-archive',
    category: 'culture',
    title: "QTIPOC archive: Lisbon's community-held queer history",
    titlePt: 'Arquivo QTIPOC: memória viva da comunidade queer em Lisboa',
    description:
      'A living, community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
    descriptionPt:
      'Um arquivo vivo da vida QTIPOC em Lisboa: ensaios fotográficos, escrita, gravações e documentos, contribuídos e creditados por quem os criou.',
    meta: 'Guide',
    body: 'A living, community-held archive of QTIPOC life in Lisbon: photo essays, writing, recordings and documents, contributed and credited by the people who made them.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'qtipoc-organisations',
    routePath: '/resources/qtipoc-organisations',
    category: 'community',
    title: 'QTIPOC organisations in Portugal and how to reach them',
    titlePt: 'Organizações QTIPOC em Portugal e como contactá-las',
    description:
      'A directory of organisations across Portugal working where race and queerness meet: housing, legal aid, youth groups and advocacy, with what they offer and how to reach them.',
    descriptionPt:
      'Grupos por todo o Portugal a trabalhar onde raça e diversidade sexual e de género se encontram: o que fazem, o que oferecem, e como contactá-las.',
    meta: 'Guide',
    body: 'A directory of organisations across Portugal working where race and queerness meet: housing, legal aid, youth groups and advocacy, with what they offer and how to reach them.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'queer-paediatricians',
    routePath: '/resources/queer-paediatricians',
    category: 'health',
    title: 'Queer-friendly paediatricians in Lisbon: parent-vetted list',
    titlePt: 'Pediatras LGBTQ+-friendly em Lisboa, recomendados por pais',
    description:
      'A peer-verified list of Lisbon paediatricians that LGBTQ+ families actually trust: doctors comfortable with two-parent forms and same-sex parents, dated and honestly reviewed.',
    descriptionPt:
      'Uma lista verificada por outros pais e mães de pediatras em Lisboa em quem as famílias LGBTQ+ realmente confiam: à vontade com duas mães ou dois pais no formulário, avaliados com honestidade.',
    meta: 'Guide',
    body: 'A peer-verified list of Lisbon paediatricians that LGBTQ+ families actually trust: doctors comfortable with two-parent forms and same-sex parents, dated and honestly reviewed.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'running-guide',
    routePath: '/resources/running-guide',
    category: 'community',
    title: 'Queer running group in Lisbon: pace groups and what to bring',
    titlePt: 'Grupo de corrida queer em Lisboa: ritmos e o que levar',
    description:
      "QueerPulse's Lisbon running group: three pace groups from social to steady, what to bring on your first run, and the rule that matters most: nobody runs alone.",
    descriptionPt:
      'O grupo de corrida da QueerPulse em Lisboa: três grupos de ritmo, do social ao mais exigente, o que levar à primeira corrida, e a regra mais importante de todas, ninguém corre sozinhe.',
    meta: 'Guide · 1 min',
    body: "Which group is yours\n\nWe split into three pace groups at the start. Pick the honest one rather than the ambitious one, and you can always move up next week. Every pace belongs here.\n\nSlow & Social\n\nFirst-timers, anyone coming back from a break, and anyone who wants to actually talk the whole way round. The slowest runner sets the pace and nobody is ever left behind.\n\nMiddle Ground\n\nYou can run 5k without stopping and want company at a comfortable, sustainable pace. The biggest group, and the easiest to slot into.\n\nFast & Focused\n\nBuilding toward a race or chasing a PB. Still social at the coffee after, just quicker on the road. We regroup at every turn so the group never splits for good.\n\nWhat to bring\n\nShort version: less than you think. Here's the whole list.\n\nTrainers you can already run in\n\nWhatever you own is fine for your first time, so don't buy anything special. If the cobbles start hurting your ankles, ask the group; we have strong opinions about Lisbon-proof shoes.\n\nLayers you can lose\n\nMornings start cool and warm up fast. Something you can tie round your waist beats a single heavy top.\n\nWater for after\n\nWe finish near coffee, so you don't need to carry much. A small bottle is plenty for the loop.\n\nNothing to prove\n\nYou don't need a running history, a certain body, or a goal. Showing up is the whole entry requirement. Come for the coffee and walk the loop if that's today's version.\n\nSee you at the start line.\n\nCoffee after is half the point. Find the next run on the gatherings board.",
    sections: [
      {
        id: 'pace',
        heading: 'Which group is yours',
        blocks: [
          {
            kind: 'paragraph',
            text: 'We split into three pace groups at the start. Pick the honest one rather than the ambitious one, and you can always move up next week. Every pace belongs here.',
          },
          { kind: 'subheading', text: 'Slow & Social' },
          {
            kind: 'paragraph',
            text: 'First-timers, anyone coming back from a break, and anyone who wants to actually talk the whole way round. The slowest runner sets the pace and nobody is ever left behind.',
          },
          { kind: 'subheading', text: 'Middle Ground' },
          {
            kind: 'paragraph',
            text: 'You can run 5k without stopping and want company at a comfortable, sustainable pace. The biggest group, and the easiest to slot into.',
          },
          { kind: 'subheading', text: 'Fast & Focused' },
          {
            kind: 'paragraph',
            text: 'Building toward a race or chasing a PB. Still social at the coffee after, just quicker on the road. We regroup at every turn so the group never splits for good.',
          },
        ],
      },
      {
        id: 'bring',
        heading: 'What to bring',
        blocks: [
          {
            kind: 'paragraph',
            text: "Short version: less than you think. Here's the whole list.",
          },
          { kind: 'subheading', text: 'Trainers you can already run in' },
          {
            kind: 'note',
            text: "Whatever you own is fine for your first time, so don't buy anything special. If the cobbles start hurting your ankles, ask the group; we have strong opinions about Lisbon-proof shoes.",
          },
          { kind: 'subheading', text: 'Layers you can lose' },
          {
            kind: 'note',
            text: 'Mornings start cool and warm up fast. Something you can tie round your waist beats a single heavy top.',
          },
          { kind: 'subheading', text: 'Water for after' },
          {
            kind: 'note',
            text: "We finish near coffee, so you don't need to carry much. A small bottle is plenty for the loop.",
          },
          { kind: 'subheading', text: 'Nothing to prove' },
          {
            kind: 'note',
            text: "You don't need a running history, a certain body, or a goal. Showing up is the whole entry requirement. Come for the coffee and walk the loop if that's today's version.",
          },
        ],
      },
      {
        id: 'outro',
        heading: 'See you at the start line.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Coffee after is half the point. Find the next run on the gatherings board.',
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'pace',
        heading: 'Qual grupo é o teu',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Dividimo-nos em três grupos de ritmo no início. Escolhe o honesto, e podes sempre subir na semana seguinte. Todos os ritmos pertencem aqui.',
          },
          { kind: 'subheading', text: 'Lento e Social' },
          {
            kind: 'paragraph',
            text: 'Quem vem pela primeira vez, quem está a voltar de uma pausa, e quem quer mesmo conversar o percurso todo. Quem corre mais devagar dita o ritmo e ninguém fica nunca para trás.',
          },
          { kind: 'subheading', text: 'Meio-Termo' },
          {
            kind: 'paragraph',
            text: 'Consegues correr 5 km sem parar e queres companhia a um ritmo confortável e sustentável. O maior grupo, e o mais fácil de encaixar.',
          },
          { kind: 'subheading', text: 'Rápido e Focado' },
          {
            kind: 'paragraph',
            text: 'A construir para uma corrida ou à procura de um recorde pessoal. Continua social no café a seguir, só mais rápido na estrada. Reagrupamo-nos em cada curva para que o grupo nunca se separe de vez.',
          },
        ],
      },
      {
        id: 'bring',
        heading: 'O que trazer',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Versão curta: menos do que pensas. Aqui está a lista completa.',
          },
          { kind: 'subheading', text: 'Ténis em que já saibas correr' },
          {
            kind: 'note',
            text: 'O que já tens serve para a primeira vez, sem precisares de comprar nada especial. Se as calçadas começarem a magoar-te os tornozelos, pergunta ao grupo; temos opiniões fortes sobre calçado à prova de Lisboa.',
          },
          { kind: 'subheading', text: 'Camadas que possas tirar' },
          {
            kind: 'note',
            text: 'As manhãs começam frescas e aquecem depressa. Algo que possas atar à cintura vale mais do que uma peça quente única.',
          },
          { kind: 'subheading', text: 'Água para depois' },
          {
            kind: 'note',
            text: 'Terminamos perto do café, por isso uma garrafa pequena chega para o percurso.',
          },
          { kind: 'subheading', text: 'Nada a provar' },
          {
            kind: 'note',
            text: 'Não precisas de um historial de corrida, de um certo corpo, ou de um objetivo. Aparecer é o único requisito de entrada. Vem pelo café e caminha o percurso se for essa a versão de hoje.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Vemo-nos na linha de partida.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'O café a seguir é metade do objetivo. Encontra a próxima corrida no quadro de encontros.',
          },
        ],
      },
    ],
  },
  {
    slug: 'school-forms-guide',
    routePath: '/resources/school-forms-guide',
    category: 'legal',
    title: 'School intake forms for queer families in Lisbon',
    titlePt: 'Formulários de matrícula escolar para famílias queer em Lisboa',
    description:
      'How to navigate school intake forms as a two-parent or queer family in Lisbon: what to expect on the fields, how to ask for both your names, and your rights.',
    descriptionPt:
      'Como navegar os formulários de admissão escolar sendo uma família queer ou com dois pais/mães em Lisboa: o que esperar nos campos, como pedir os dois nomes, e os teus direitos.',
    meta: 'Guide',
    body: 'How to navigate school intake forms as a two-parent or queer family in Lisbon: what to expect on the fields, how to ask for both your names, and your rights.',
    sections: [],
    sectionsPt: null,
  },
  {
    slug: 'shared-equipment',
    routePath: '/resources/shared-equipment',
    category: 'culture',
    title: 'Shared studio equipment: the Rainbow Arts kit library',
    titlePt: 'Equipamento partilhado: o material do coletivo Rainbow Arts',
    description:
      "The risograph, kiln, projector and bookbinding kit the Rainbow Arts collective shares in Lisbon: what's available, how to book it, and how the community keeps it in good shape.",
    descriptionPt:
      'A risógrafa, o forno de cerâmica, o projetor e o kit de encadernação que o coletivo Rainbow Arts partilha em Lisboa: o que está disponível, como reservar, e como cuidamos do material.',
    meta: 'Guide · 1 min',
    body: 'The kit\n\nAll of it lives at the atelier. Tap request and a mod confirms your slot.\n\nTwo-colour Risograph\n\nReconditioned RZ, A3, currently loaded coral + black. Lives at the atelier for collective use.\n\nElectric kiln\n\nMid-size top-loader, cone 6. Firings are scheduled, so add yours to the shared sheet a week ahead.\n\nProjector + stand\n\n1080p, long-throw, good for tracing and projection work. Portable with the soft case.\n\nBookbinding kit\n\nAwls, bone folders, waxed thread, board shears. For zines and small editions.\n\nHow we care for it\n\nBook it, clean it, log it: the three rules that keep shared kit shared.\n\nLeave it better than you found it. If something breaks, say so in the channel; nobody is in trouble, we just need to know.\n\nConsumables (ink, thread, board) work on a top-up honesty box. Use a lot, chip in a little.\n\nMake something.\n\nThe kit is here so the work can happen. Come to a print day and put it to use.',
    sections: [
      {
        id: 'kit',
        heading: 'The kit',
        blocks: [
          {
            kind: 'paragraph',
            text: 'All of it lives at the atelier. Tap request and a mod confirms your slot.',
          },
          { kind: 'subheading', text: 'Two-colour Risograph' },
          {
            kind: 'paragraph',
            text: 'Reconditioned RZ, A3, currently loaded coral + black. Lives at the atelier for collective use.',
          },
          { kind: 'subheading', text: 'Electric kiln' },
          {
            kind: 'paragraph',
            text: 'Mid-size top-loader, cone 6. Firings are scheduled, so add yours to the shared sheet a week ahead.',
          },
          { kind: 'subheading', text: 'Projector + stand' },
          {
            kind: 'paragraph',
            text: '1080p, long-throw, good for tracing and projection work. Portable with the soft case.',
          },
          { kind: 'subheading', text: 'Bookbinding kit' },
          {
            kind: 'paragraph',
            text: 'Awls, bone folders, waxed thread, board shears. For zines and small editions.',
          },
        ],
      },
      {
        id: 'care',
        heading: 'How we care for it',
        blocks: [
          {
            kind: 'listItem',
            text: 'Book it, clean it, log it: the three rules that keep shared kit shared.',
          },
          {
            kind: 'listItem',
            text: 'Leave it better than you found it. If something breaks, say so in the channel; nobody is in trouble, we just need to know.',
          },
          {
            kind: 'listItem',
            text: 'Consumables (ink, thread, board) work on a top-up honesty box. Use a lot, chip in a little.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Make something.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'The kit is here so the work can happen. Come to a print day and put it to use.',
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'kit',
        heading: 'O material',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Está tudo no atelier. Toca em pedir e uma pessoa moderadora confirma o teu horário.',
          },
          { kind: 'subheading', text: 'Risógrafo a duas cores' },
          {
            kind: 'paragraph',
            text: 'RZ recondicionado, A3, atualmente com coral + preto carregados. Fica no atelier para uso coletivo.',
          },
          { kind: 'subheading', text: 'Forno elétrico de cerâmica' },
          {
            kind: 'paragraph',
            text: 'Modelo de carregamento superior, tamanho médio, cone 6. As cozeduras são agendadas: junta a tua à folha partilhada com uma semana de antecedência.',
          },
          { kind: 'subheading', text: 'Projetor + suporte' },
          {
            kind: 'paragraph',
            text: '1080p, alcance longo, bom para decalque e trabalho de projeção. Portátil, com bolsa protetora.',
          },
          { kind: 'subheading', text: 'Kit de encadernação' },
          {
            kind: 'paragraph',
            text: 'Sovelas, dobradores de osso, linha encerada, guilhotina de cartão. Para zines e edições pequenas.',
          },
        ],
      },
      {
        id: 'care',
        heading: 'Como cuidamos dele',
        blocks: [
          {
            kind: 'listItem',
            text: 'Reserva, limpa, regista: as três regras que mantêm o material partilhado partilhável.',
          },
          {
            kind: 'listItem',
            text: 'Deixa-o melhor do que o encontraste. Se algo se partir, diz no canal; ninguém está em sarilhos, só precisamos de saber.',
          },
          {
            kind: 'listItem',
            text: 'Os consumíveis (tinta, linha, cartão) funcionam por caixa de honestidade com reposição. Usa bastante, contribui um pouco.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Faz alguma coisa.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'O material está aqui para que o trabalho aconteça. Vem a um dia de impressão e usa-o.',
          },
        ],
      },
    ],
  },
  {
    slug: 'spoon-theory',
    routePath: '/resources/spoon-theory',
    category: 'health',
    title: 'Spoon theory explained: how this queer community uses it',
    titlePt: 'Teoria das colheres: como a usamos nesta comunidade queer',
    description:
      "What spoon theory means, and how QueerPulse applies it for chronic illness and disability: hybrid events by default, no-penalty drop-outs, and permission to say 'I'm low on spoons.'",
    descriptionPt:
      "O que é a teoria das colheres e como a QueerPulse a usa para doença crónica e deficiência: eventos híbridos por defeito, faltar sem penalização, e 'estou com poucas colheres' como frase válida.",
    meta: 'Guide · 1 min',
    body: "What it is\n\nFour spoons left of six, a normal afternoon.\n\nSpoon theory is a simple way to talk about limited energy. You start the day with a set number of spoons, and every task, from showering to commuting to a hard conversation, costs one or more. When they are gone, they are gone, and tomorrow does not always refill them.\n\nIt is not a metaphor for being tired. It is a way for people with chronic illness, disability, and chronic pain to make an invisible limit visible, to themselves and to each other, without writing an essay about it.\n\nHow we use it\n\nHybrid by default\n\nEvery gathering has an online option so a low-spoon day never means missing out. Online is another door into the same room, and it counts the same.\n\nDrop-in, no penalty\n\nRSVP yes and not make it? Completely fine. We plan for it. The spoons you protect by staying home are yours to protect.\n\n\"I'm low on spoons today\" is a full sentence\n\nNobody here will ask you to justify it. You can say it when you RSVP, when you arrive, or when you need to leave early, and it will simply be honoured.\n\nWhen you RSVP\n\nTell the host your spoon count if it helps them plan: seating, quiet corners, an easy exit near the door.\n\nAsk for what you need up front; it will be arranged without fuss and without comment.\n\nCarers and personal assistants are always welcome, no booking required.\n\nCome in whatever state you're in.\n\nWe're not measuring. Every gathering is hybrid, drop-in, and built for real bodies.",
    sections: [
      {
        id: 'what',
        heading: 'What it is',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Four spoons left of six, a normal afternoon.',
          },
          {
            kind: 'paragraph',
            text: 'Spoon theory is a simple way to talk about limited energy. You start the day with a set number of spoons, and every task, from showering to commuting to a hard conversation, costs one or more. When they are gone, they are gone, and tomorrow does not always refill them.',
          },
          {
            kind: 'paragraph',
            text: 'It is not a metaphor for being tired. It is a way for people with chronic illness, disability, and chronic pain to make an invisible limit visible, to themselves and to each other, without writing an essay about it.',
          },
        ],
      },
      {
        id: 'uses',
        heading: 'How we use it',
        blocks: [
          { kind: 'subheading', text: 'Hybrid by default' },
          {
            kind: 'paragraph',
            text: 'Every gathering has an online option so a low-spoon day never means missing out. Online is another door into the same room, and it counts the same.',
          },
          { kind: 'subheading', text: 'Drop-in, no penalty' },
          {
            kind: 'paragraph',
            text: 'RSVP yes and not make it? Completely fine. We plan for it. The spoons you protect by staying home are yours to protect.',
          },
          {
            kind: 'subheading',
            text: '"I\'m low on spoons today" is a full sentence',
          },
          {
            kind: 'paragraph',
            text: 'Nobody here will ask you to justify it. You can say it when you RSVP, when you arrive, or when you need to leave early, and it will simply be honoured.',
          },
        ],
      },
      {
        id: 'rsvp',
        heading: 'When you RSVP',
        blocks: [
          {
            kind: 'listItem',
            text: 'Tell the host your spoon count if it helps them plan: seating, quiet corners, an easy exit near the door.',
          },
          {
            kind: 'listItem',
            text: 'Ask for what you need up front; it will be arranged without fuss and without comment.',
          },
          {
            kind: 'listItem',
            text: 'Carers and personal assistants are always welcome, no booking required.',
          },
        ],
      },
      {
        id: 'outro',
        heading: "Come in whatever state you're in.",
        blocks: [
          {
            kind: 'paragraph',
            text: "We're not measuring. Every gathering is hybrid, drop-in, and built for real bodies.",
          },
        ],
      },
    ],
    sectionsPt: [
      {
        id: 'what',
        heading: 'O que é',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Quatro colheres restantes de seis, uma tarde normal.',
          },
          {
            kind: 'paragraph',
            text: 'A teoria das colheres é uma forma simples de falar sobre energia limitada. Começas o dia com um número certo de colheres, e cada tarefa (tomar banho, deslocar-te, uma conversa difícil) custa uma ou mais. Quando acabam, acabam, e o dia seguinte nem sempre as repõe.',
          },
          {
            kind: 'paragraph',
            text: 'É uma forma de pessoas com doença crónica, deficiência e dor crónica tornarem visível um limite invisível, para si próprias e umas para as outras, sem terem de escrever um ensaio sobre isso.',
          },
        ],
      },
      {
        id: 'uses',
        heading: 'Como a usamos',
        blocks: [
          { kind: 'subheading', text: 'Híbrido por defeito' },
          {
            kind: 'paragraph',
            text: 'Todos os encontros têm opção online, para que um dia de poucas colheres nunca signifique ficar de fora. Online é outra porta para a mesma sala, com o mesmo peso.',
          },
          { kind: 'subheading', text: 'Aparece se puderes, sem penalização' },
          {
            kind: 'paragraph',
            text: 'Confirmaste presença e não consegues ir? Sem problema. Contamos com isso. As colheres que poupas ao ficar em casa são tuas para guardar.',
          },
          {
            kind: 'subheading',
            text: '"Hoje estou com poucas colheres" já é uma frase completa',
          },
          {
            kind: 'paragraph',
            text: 'Ninguém aqui te vai pedir para justificares. Podes dizê-lo ao confirmares presença, quando chegas, ou quando precisas de sair mais cedo, e será simplesmente respeitado.',
          },
        ],
      },
      {
        id: 'rsvp',
        heading: 'Ao confirmar presença',
        blocks: [
          {
            kind: 'listItem',
            text: 'Diz à pessoa anfitriã quantas colheres tens, se ajudar no planeamento: lugares sentados, cantos calmos, uma saída fácil perto da porta.',
          },
          {
            kind: 'listItem',
            text: 'Pede o que precisas com antecedência; será tratado sem alarido e sem comentários.',
          },
          {
            kind: 'listItem',
            text: 'Cuidadores e assistentes pessoais são sempre bem-vindes, sem necessidade de reserva.',
          },
        ],
      },
      {
        id: 'outro',
        heading: 'Vem como estiveres.',
        blocks: [
          {
            kind: 'paragraph',
            text: 'Não estamos a medir nada. Todos os encontros são híbridos, sem compromisso de chegada, e feitos para corpos reais.',
          },
        ],
      },
    ],
  },
  {
    slug: 'intersectionality',
    routePath: '/resources/intersectionality',
    category: 'community',
    title: "Race, faith and class in Lisbon's queer community",
    titlePt: 'Raça, fé e classe na comunidade queer de Lisboa',
    description:
      'How race, faith, class, and disability intersect with queerness in Lisbon: member voices and resources for people navigating more than one identity at once.',
    descriptionPt:
      'Como raça, fé, classe e deficiência se cruzam com a identidade queer em Lisboa: vozes de membros e recursos para quem vive mais do que uma identidade ao mesmo tempo.',
    meta: 'Guide',
    body: 'How race, faith, class, and disability intersect with queerness in Lisbon: member voices and resources for people navigating more than one identity at once.',
    sections: [],
    sectionsPt: null,
  },
];

const GLOSSARY_TERMS: BackfillTerm[] = [
  {
    slug: 'aro-ace-spectrum',
    term: 'Aro/ace spectrum',
    definition:
      'Umbrella terms for people on the aromantic or asexual spectra, including grey-ace, demi, and aro-but-allosexual. Not the same as celibate. See also romantic orientation.',
    definitionPt:
      'Termos abrangentes para pessoas nos espetros arromântico ou assexual, incluindo grey-ace, demi e aro-mas-alossexual. Não é o mesmo que celibato. Ver também orientação romântica.',
    category: 'Identity',
  },
  {
    slug: 'affirming-care',
    term: 'Affirming care',
    definition:
      'A clinical approach that treats the patient\'s stated identity as the working truth, rather than something to interrogate or override. The opposite of "gatekeeper" care. WPATH guidelines describe it; in Portugal, Lei n.º 38/2018 codifies parts of it.',
    definitionPt:
      'Uma abordagem clínica que trata a identidade declarada da pessoa como verdade de trabalho, em vez de algo a interrogar ou contrariar. O oposto do cuidado "gatekeeper". As diretrizes da WPATH descrevem-na; em Portugal, a Lei n.º 38/2018 codifica parte dela.',
    category: 'Healthcare',
  },
  {
    slug: 'anjos',
    term: 'Anjos',
    definition:
      'A central Lisbon neighbourhood that, since the late 2010s, has hosted much of the city\'s organised queer community space, including Clínica do Largo and the Trans Hub office. Not a "gayborhood" in the Castro sense. The community is woven into the existing residential fabric.',
    definitionPt:
      'Um bairro central de Lisboa que, desde o final da década de 2010, acolhe grande parte do espaço comunitário queer organizado da cidade, incluindo a Clínica do Largo e o escritório do Trans Hub. Não é um "gayborhood" ao estilo de Castro. A comunidade está entrelaçada no tecido residencial existente.',
    category: 'Lisbon',
  },
  {
    slug: 'assigned-at-birth',
    term: 'Assigned at birth',
    definition:
      "As in AFAB / AMAB: the sex marker placed on a person's birth certificate. The phrasing emphasises that this was a decision made by others, often without examination. Useful in medical contexts; less needed in social ones.",
    definitionPt:
      'Como em AFAB / AMAB: o marcador de sexo colocado na certidão de nascimento. A expressão sublinha que foi uma decisão tomada por outros, muitas vezes sem reflexão. Útil em contextos médicos; menos necessária nos sociais.',
    category: 'Essential',
  },
  {
    slug: 'binary',
    term: 'Binary',
    definition:
      'Of gender systems that recognise only two categories (man / woman). The word is often a shorthand for limitations, not a description of any individual.',
    definitionPt:
      'De sistemas de género que reconhecem apenas duas categorias (homem / mulher). A palavra é muitas vezes uma forma abreviada de limitações, e não a descrição de uma pessoa.',
    category: 'Identity',
  },
  {
    slug: 'bichas',
    term: 'Bichas',
    definition:
      'A reclaimed Portuguese term, roughly equivalent to "queer" used as a noun, used widely within the community. Reclamation matters here. Use only if you\'re inside; otherwise, opt for queer.',
    definitionPt:
      'Um termo português reapropriado, aproximadamente equivalente a "queer" usado como substantivo, muito usado dentro da comunidade. A reapropriação importa aqui. Use apenas se fizer parte; caso contrário, opte por queer.',
    category: 'Portuguese · in-community',
  },
  {
    slug: 'butch-femme',
    term: 'Butch / Femme',
    definition:
      "Long-standing terms for masc and femme presentations within queer (particularly lesbian and trans-masc) communities. Identity, not costume. Discussions about who can use them are ongoing. We don't adjudicate.",
    definitionPt:
      'Termos antigos para apresentações masc e femme dentro das comunidades queer (em particular lésbicas e trans-masc). Identidade, não fantasia. As discussões sobre quem os pode usar continuam. Não as arbitramos.',
    category: 'Identity · contested',
  },
  {
    slug: 'cis',
    term: 'Cis',
    definition:
      'Short for cisgender, describing a person whose gender matches the one they were assigned at birth. Not an insult, not a slur, just a descriptor, symmetric to "trans". Latin: cis- means "on this side of".',
    definitionPt:
      'Abreviatura de cisgénero, descreve uma pessoa cujo género corresponde ao que lhe foi atribuído à nascença. Não é insulto nem ofensa, apenas um descritor, simétrico a "trans". Do latim: cis- significa "deste lado de".',
    category: 'Essential',
  },
  {
    slug: 'chosen-family',
    term: 'Chosen family',
    definition:
      "The set of intentional, ongoing relationships of care that queer people build, often in parallel with (and sometimes in place of) biological family. Includes lovers, exes, friends, neighbours, and the person who calls if you don't post for three days.",
    definitionPt:
      'O conjunto de relações de cuidado intencionais e contínuas que as pessoas queer constroem, muitas vezes em paralelo com (e por vezes em vez de) a família biológica. Inclui amantes, ex-namorades, amigues, vizinhes e a pessoa que liga se não publicares nada durante três dias.',
    category: 'Essential',
  },
  {
    slug: 'coming-out',
    term: 'Coming out',
    definition:
      'The ongoing act of disclosing a non-heterosexual or non-cisgender identity. Not a one-time event. Most queer people come out hundreds of times: to coworkers, to taxi drivers, to landlords, to GPs.',
    definitionPt:
      'O ato contínuo de revelar uma identidade não-heterossexual ou não-cisgénero. Não é um acontecimento único. A maioria das pessoas queer assume-se centenas de vezes: a colegas, a taxistas, a senhorios, a médicos de família.',
    category: 'Essential',
  },
  {
    slug: 'deadname',
    term: 'Deadname',
    definition:
      "The name a trans person no longer uses, typically the one assigned at birth. Don't use it, even with permission, even in the past tense, even at a doctor's office. Lei n.º 38/2018 permits self-determination of name on most records in Portugal.",
    definitionPt:
      'O nome que uma pessoa trans já não usa, normalmente o atribuído à nascença. Não o uses, nem com permissão, nem no passado, nem no consultório médico. A Lei n.º 38/2018 permite a autodeterminação do nome na maioria dos registos em Portugal.',
    category: 'Healthcare',
  },
  {
    slug: 'drag',
    term: 'Drag',
    definition:
      "A theatrical performance of gender. Not the same as being trans. Drag has a queer history, but plenty of straight and cis people do it; plenty of trans people don't.",
    definitionPt:
      'Uma performance teatral de género. Não é o mesmo que ser trans. O drag tem uma história queer, mas muitas pessoas hétero e cis também o fazem; e muitas pessoas trans não.',
    category: 'Performance',
  },
  {
    slug: 'vouch',
    term: 'Vouch',
    definition:
      "On QueerPulse, to vouch for someone is to attach your name to theirs as a marker of community trust. Used in three places: member onboarding (you vouch for who you're inviting), safe spaces (you vouch a venue lives up to the pact), and service offers (you vouch a therapist or skill-provider is what they say). Vouches are personal. They accumulate, they don't get rated.",
    definitionPt:
      'No QueerPulse, abonar por alguém é associar o teu nome ao dela como marca de confiança comunitária. Usa-se em três lugares: entrada de membros (abonas por quem convidas), espaços seguros (abonas que um espaço cumpre o pacto) e ofertas de serviços (abonas que um terapeuta ou prestador é o que diz). Os abonos são pessoais. Acumulam-se, não são avaliados.',
    category: 'QueerPulse · platform',
  },
  {
    slug: 'wpath',
    term: 'WPATH',
    definition:
      'The World Professional Association for Transgender Health. Publishes the Standards of Care, the most widely-used clinical guidelines for trans-affirming care. Currently on version 8. Used by most Lisbon clinicians who self-identify as trans-affirming.',
    definitionPt:
      'A World Professional Association for Transgender Health. Publica os Standards of Care, as diretrizes clínicas mais usadas para o cuidado afirmativo trans. Atualmente na versão 8. Usada pela maioria dos clínicos de Lisboa que se identificam como afirmativos para pessoas trans.',
    category: 'Healthcare',
  },
];

export class BackfillResourceGuides1794833210000 implements MigrationInterface {
  name = 'BackfillResourceGuides1794833210000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const guide of GUIDES) {
      await queryRunner.query(
        `INSERT INTO "resources" (
           "slug", "category", "title", "description", "body", "meta",
           "title_pt", "description_pt", "sections", "sections_pt",
           "route_path", "published_at", "review_due_on"
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, now(), CURRENT_DATE)
         ON CONFLICT ("slug") DO NOTHING`,
        [
          guide.slug,
          guide.category,
          guide.title,
          guide.description,
          guide.body,
          guide.meta,
          guide.titlePt,
          guide.descriptionPt,
          JSON.stringify(guide.sections),
          guide.sectionsPt === null ? null : JSON.stringify(guide.sectionsPt),
          guide.routePath,
        ],
      );
    }

    for (const term of GLOSSARY_TERMS) {
      await queryRunner.query(
        `INSERT INTO "glossary_terms" (
           "slug", "term", "definition", "definition_pt", "category", "review_due_on"
         )
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE)
         ON CONFLICT ("slug") DO NOTHING`,
        [
          term.slug,
          term.term,
          term.definition,
          term.definitionPt,
          term.category,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "resources" WHERE "slug" = ANY($1)`, [
      GUIDES.map((guide) => guide.slug),
    ]);
    await queryRunner.query(
      `DELETE FROM "glossary_terms" WHERE "slug" = ANY($1)`,
      [GLOSSARY_TERMS.map((term) => term.slug)],
    );
  }
}
