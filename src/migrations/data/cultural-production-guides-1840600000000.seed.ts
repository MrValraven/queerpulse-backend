/**
 * A frozen copy of the four starter guides written on 2026-11-20 (Board game
 * night and Quiz night, English and Portuguese). It seeds
 * AddCulturalProduction1840600000000. Do not edit: staff edit the guides on
 * the Cultural Production page once the migration has run. The frontend demo
 * copy lives in
 * queerpulse/src/features/admin/culturalProduction/culturalGuidesDemo.data.ts.
 */
export interface CulturalGuideSeed {
  id: string;
  title: string;
  eventType: 'board_game_night' | 'quiz_night';
  locale: 'en' | 'pt';
  summary: string;
  sections: Array<{
    heading: string;
    body: string;
    steps: Array<{ text: string; daysBefore: number | null }>;
  }>;
}

/** The four starter guides of contract section 14, in contract order. */
export const CULTURAL_PRODUCTION_GUIDE_SEEDS_1840600000000: readonly CulturalGuideSeed[] =
  [
    {
      id: 'c5a1e000-5eed-4000-8000-000000000001',
      title: 'Board game night',
      eventType: 'board_game_night',
      locale: 'en',
      summary:
        'How QueerPulse runs a board game night: a welcoming venue, a shelf of games that teach in five minutes, a host for every two or three tables, and a seat ready for anyone who comes alone.',
      sections: [
        {
          heading: 'The night in short',
          body: [
            'A board game night is a relaxed evening where people who may never have met share a table and learn a game together. It works best on a weeknight, from 19:00 to 23:00, for 24 to 40 people.',
            '',
            'What makes it a QueerPulse night:',
            '- Everyone who comes alone has a seat at a table within ten minutes of arriving.',
            '- Games teach fast and need little reading, so Portuguese and English speakers can share a table.',
            '- Hosts look after the room, so everyone gets a turn, the quiet players included.',
          ].join('\n'),
          steps: [
            {
              text: 'Pick the date and the start time (a weeknight at 19:00 works well)',
              daysBefore: 42,
            },
            {
              text: 'Set the capacity from the number of tables the venue can give you',
              daysBefore: 35,
            },
          ],
        },
        {
          heading: 'Venue',
          body: [
            'Look for a bar, café or community space with tables that seat four to six, good light, and a sound level where you can explain rules without shouting.',
            '',
            'Check before you confirm:',
            '- A step-free entrance and at least one step-free, gender-neutral toilet',
            '- Food and drinks at fair prices, with options without alcohol',
            '- Opening hours until at least 23:00',
            '- Any minimum spend, in writing',
            '- A shelf or corner where the game library can sit',
            '',
            'Visit on the same day of the week and at the same hour as the event, so you hear the real noise level.',
          ].join('\n'),
          steps: [
            {
              text: 'Shortlist two or three venues and visit them at the same hour as the event',
              daysBefore: 40,
            },
            {
              text: 'Confirm the venue in writing: date, hours, number of tables and any minimum spend',
              daysBefore: 35,
            },
            {
              text: 'Write the access details (entrance, toilets, seating) on the event page',
              daysBefore: 28,
            },
          ],
        },
        {
          heading: 'Games',
          body: [
            'Plan about one game for every three people coming, so 12 to 15 games for a night of 40. Mix the shelf:',
            '- Quick party games for big groups: Codenames, Just One, Wavelength, Dixit',
            '- Light strategy for four: Ticket to Ride, Carcassonne, Azul, Splendor',
            '- Co-operative games, where the whole table plays together: The Crew, Hanabi, Forbidden Island',
            '- Two-player games for pairs who arrive together: Patchwork, Jaipur',
            '- One longer game for a table that wants it, announced in advance',
            '',
            'Choose games with little text on the cards. Borrow from the team and from regulars, and keep a list of who lent what.',
          ].join('\n'),
          steps: [
            {
              text: 'Ask the team and regulars which games they can lend, and list each game with its owner',
              daysBefore: 21,
            },
            {
              text: 'Check every box for missing pieces and bag the small parts',
              daysBefore: 3,
            },
            {
              text: 'Print a one-page game menu with the player count and play time of each game',
              daysBefore: 2,
            },
          ],
        },
        {
          heading: 'Hosts',
          body: [
            'Plan one host for every two or three tables, plus one door host.',
            '',
            'The door host welcomes each person, asks if it is their first QueerPulse night, and walks people who came alone to a table with a host.',
            '',
            'Each table host knows two or three games well enough to teach them in five minutes. They start the first game, keep turns moving, and check in with anyone who looks left out. Hosts play too: the night should feel like friends around a table.',
          ].join('\n'),
          steps: [
            {
              text: 'Ask for hosts in the team chat: one for every two or three tables, plus a door host',
              daysBefore: 21,
            },
            {
              text: 'Confirm the hosts and tell each one which games they will teach',
              daysBefore: 10,
            },
            {
              text: 'Brief the hosts: arrival time, how the welcome works, and who to call if something goes wrong',
              daysBefore: 1,
            },
          ],
        },
        {
          heading: 'Promotion',
          body: [
            'Publish the event on QueerPulse early, with the venue, the access details, the capacity and a line for newcomers: you can come alone, and a host will find you a table.',
            '',
            'Then share it where people already are:',
            '- The communities that fit the night, as an event they can join',
            "- The team's own channels and social accounts",
            '- A poster at the venue a week before',
            '',
            'Photos of the game shelf work well in reminders.',
          ].join('\n'),
          steps: [
            {
              text: 'Publish the event on QueerPulse with the venue, access details and capacity',
              daysBefore: 28,
            },
            {
              text: 'Share the event in the communities that fit the night',
              daysBefore: 21,
            },
            {
              text: 'Post a reminder with a photo of the game shelf',
              daysBefore: 7,
            },
            { text: 'Post a last call', daysBefore: 1 },
          ],
        },
        {
          heading: 'The night itself',
          body: [
            'A timeline that works:',
            '- 18:15 Hosts arrive, set up the tables, put a game menu on each one and set up the welcome point with name stickers and pens for names and pronouns',
            '- 19:00 Doors open. The door host welcomes people and seats newcomers with a host',
            '- 19:15 First games start, one quick game per table',
            '- 20:30 Tables swap games, and anyone who wants to change tables can',
            '- 22:30 Last game',
            '- 23:00 Everyone packs up together',
            '',
            'Through the night, anyone can sit a game out and everyone chooses their own games. If something goes wrong, the door host is the first person to talk to.',
          ].join('\n'),
          steps: [
            {
              text: 'Pack the games, the game menus, name stickers and pens',
              daysBefore: 0,
            },
            {
              text: 'Set up the tables and the welcome point before the doors open',
              daysBefore: 0,
            },
          ],
        },
        {
          heading: 'Wrap-up',
          body: [
            "Before you leave, count the pieces back into each box and keep lent games apart from the venue's.",
            '',
            'In the days after:',
            '- Return every lent game to its owner',
            '- Thank the venue and the hosts',
            '- Share photos only of people who said yes to being in them',
            '- Write down how many people came, which games were a hit and what to change, then add it as an idea or update this guide',
          ].join('\n'),
          steps: [
            { text: 'Thank the venue and the hosts', daysBefore: -1 },
            { text: 'Return every lent game to its owner', daysBefore: -2 },
            {
              text: 'Write down attendance and what to change, and update this guide',
              daysBefore: -3,
            },
          ],
        },
      ],
    },
    {
      id: 'c5a1e000-5eed-4000-8000-000000000002',
      title: 'Noite de jogos de tabuleiro',
      eventType: 'board_game_night',
      locale: 'pt',
      summary:
        'Como o QueerPulse organiza uma noite de jogos de tabuleiro: um espaço acolhedor, uma estante de jogos que se explicam em cinco minutos, um host por cada duas ou três mesas e um lugar à espera de quem vem sem companhia.',
      sections: [
        {
          heading: 'A noite em resumo',
          body: [
            'Uma noite de jogos de tabuleiro é um serão descontraído em que pessoas que talvez nunca se tenham cruzado partilham uma mesa e aprendem um jogo juntas. Funciona melhor a meio da semana, das 19:00 às 23:00, para 24 a 40 pessoas.',
            '',
            'O que faz dela uma noite QueerPulse:',
            '- Quem vem sem companhia tem lugar numa mesa nos primeiros dez minutos.',
            '- Os jogos explicam-se depressa e têm pouco texto, por isso quem fala português e quem fala inglês pode jogar na mesma mesa.',
            '- Os hosts cuidam da sala, para que toda a gente tenha a sua vez, incluindo quem fala menos.',
          ].join('\n'),
          steps: [
            {
              text: 'Escolhe a data e a hora de início (um dia de semana às 19:00 funciona bem)',
              daysBefore: 42,
            },
            {
              text: 'Define a lotação a partir do número de mesas que o espaço te pode dar',
              daysBefore: 35,
            },
          ],
        },
        {
          heading: 'Espaço',
          body: [
            'Procura um bar, café ou espaço comunitário com mesas para quatro a seis pessoas, boa luz e um nível de ruído que deixe explicar regras sem gritar.',
            '',
            'Confirma antes de fechar:',
            '- Entrada sem degraus e pelo menos uma casa de banho sem degraus e para todos os géneros',
            '- Comida e bebida a preços justos, com opções sem álcool',
            '- Horário até pelo menos às 23:00',
            '- Consumo mínimo, se houver, por escrito',
            '- Uma prateleira ou um canto onde a ludoteca possa ficar',
            '',
            'Visita o espaço no mesmo dia da semana e à mesma hora do evento, para ouvires o ruído real.',
          ].join('\n'),
          steps: [
            {
              text: 'Faz uma lista de dois ou três espaços e visita-os à mesma hora do evento',
              daysBefore: 40,
            },
            {
              text: 'Confirma o espaço por escrito: data, horário, número de mesas e consumo mínimo',
              daysBefore: 35,
            },
            {
              text: 'Escreve os detalhes de acessibilidade (entrada, casas de banho, lugares) na página do evento',
              daysBefore: 28,
            },
          ],
        },
        {
          heading: 'Jogos',
          body: [
            'Conta com cerca de um jogo por cada três pessoas, ou seja, 12 a 15 jogos para uma noite de 40. Mistura a estante:',
            '- Jogos rápidos para grupos grandes: Codenames, Just One, Wavelength, Dixit',
            '- Estratégia leve para quatro: Ticket to Ride, Carcassonne, Azul, Splendor',
            '- Jogos cooperativos, em que a mesa inteira joga em conjunto: The Crew, Hanabi, Forbidden Island',
            '- Jogos para duas pessoas, para quem chega em par: Patchwork, Jaipur',
            '- Um jogo mais longo para uma mesa que o queira, anunciado com antecedência',
            '',
            'Escolhe jogos com pouco texto nas cartas. Pede emprestado à equipa e às pessoas habituais, e guarda uma lista de quem emprestou o quê.',
          ].join('\n'),
          steps: [
            {
              text: 'Pergunta à equipa e às pessoas habituais que jogos podem emprestar e regista cada jogo com o nome de quem o emprestou',
              daysBefore: 21,
            },
            {
              text: 'Verifica se falta alguma peça em cada caixa e põe as peças pequenas em saquinhos',
              daysBefore: 3,
            },
            {
              text: 'Imprime um menu de jogos numa página, com o número de jogadores e a duração de cada jogo',
              daysBefore: 2,
            },
          ],
        },
        {
          heading: 'Hosts',
          body: [
            'Conta com um host por cada duas ou três mesas, mais uma pessoa na porta.',
            '',
            'A pessoa da porta recebe cada pessoa, pergunta se é a primeira noite QueerPulse e leva quem veio sem companhia até uma mesa com host.',
            '',
            'Cada host de mesa conhece dois ou três jogos bem o suficiente para os explicar em cinco minutos. Começa o primeiro jogo, mantém as jogadas a andar e vai ver como está quem parece estar à parte. Os hosts também jogam: a noite deve parecer um grupo de amigos à volta de uma mesa.',
          ].join('\n'),
          steps: [
            {
              text: 'Pede hosts no chat da equipa: um por cada duas ou três mesas, mais uma pessoa para a porta',
              daysBefore: 21,
            },
            {
              text: 'Confirma os hosts e diz a cada um que jogos vai explicar',
              daysBefore: 10,
            },
            {
              text: 'Faz o briefing aos hosts: hora de chegada, como funciona o acolhimento e a quem ligar se algo correr mal',
              daysBefore: 1,
            },
          ],
        },
        {
          heading: 'Divulgação',
          body: [
            'Publica o evento no QueerPulse com tempo, com o espaço, os detalhes de acessibilidade, a lotação e uma frase para quem vem pela primeira vez: podes vir sem companhia, um host encontra-te uma mesa.',
            '',
            'Depois partilha onde as pessoas já estão:',
            '- As comunidades que fazem sentido para a noite, como um evento a que se podem juntar',
            '- Os canais e as redes sociais da equipa',
            '- Um cartaz no espaço uma semana antes',
            '',
            'Fotos da estante de jogos funcionam bem nos lembretes.',
          ].join('\n'),
          steps: [
            {
              text: 'Publica o evento no QueerPulse com o espaço, os detalhes de acessibilidade e a lotação',
              daysBefore: 28,
            },
            {
              text: 'Partilha o evento nas comunidades que fazem sentido para a noite',
              daysBefore: 21,
            },
            {
              text: 'Publica um lembrete com uma foto da estante de jogos',
              daysBefore: 7,
            },
            { text: 'Publica uma última chamada', daysBefore: 1 },
          ],
        },
        {
          heading: 'A noite',
          body: [
            'Um horário que funciona:',
            '- 18:15 Os hosts chegam, montam as mesas, põem um menu de jogos em cada uma e preparam o ponto de acolhimento com autocolantes e canetas para nomes e pronomes',
            '- 19:00 Abrem as portas. A pessoa da porta recebe toda a gente e senta quem vem pela primeira vez com um host',
            '- 19:15 Começam os primeiros jogos, um jogo rápido por mesa',
            '- 20:30 As mesas trocam de jogo e quem quiser mudar de mesa muda',
            '- 22:30 Último jogo',
            '- 23:00 Toda a gente arruma em conjunto',
            '',
            'Durante a noite, qualquer pessoa pode ficar de fora de um jogo e cada pessoa escolhe os seus jogos. Se algo correr mal, a pessoa da porta é a primeira com quem falar.',
          ].join('\n'),
          steps: [
            {
              text: 'Leva os jogos, os menus de jogos, os autocolantes e as canetas',
              daysBefore: 0,
            },
            {
              text: 'Monta as mesas e o ponto de acolhimento antes de abrirem as portas',
              daysBefore: 0,
            },
          ],
        },
        {
          heading: 'Depois do evento',
          body: [
            'Antes de sair, conta as peças de volta para cada caixa e separa os jogos emprestados dos do espaço.',
            '',
            'Nos dias a seguir:',
            '- Devolve cada jogo emprestado a quem o emprestou',
            '- Agradece ao espaço e aos hosts',
            '- Partilha fotos só de quem disse que sim a aparecer nelas',
            '- Regista quantas pessoas vieram, que jogos foram um sucesso e o que mudar, e junta isso como ideia ou atualiza este guia',
          ].join('\n'),
          steps: [
            { text: 'Agradece ao espaço e aos hosts', daysBefore: -1 },
            {
              text: 'Devolve cada jogo emprestado a quem o emprestou',
              daysBefore: -2,
            },
            {
              text: 'Regista a afluência e o que mudar, e atualiza este guia',
              daysBefore: -3,
            },
          ],
        },
      ],
    },
    {
      id: 'c5a1e000-5eed-4000-8000-000000000003',
      title: 'Quiz night',
      eventType: 'quiz_night',
      locale: 'en',
      summary:
        'How QueerPulse runs a quiz night on Pulse Live: teams answer on their phones, the questions show on a big screen, a quizmaster keeps the energy up, and every round is one everyone can play.',
      sections: [
        {
          heading: 'The night in short',
          body: [
            'Teams of two to six play five or six rounds over about two hours. Questions show on a projector or a TV and teams answer on their phones through Pulse Live, which also keeps the score. People who come alone join a team at the door.',
            '',
            'A good QueerPulse quiz mixes queer culture, music, pictures and a local Lisbon round, with easy and hard questions in every round so every team keeps up.',
          ].join('\n'),
          steps: [
            {
              text: 'Pick the date, the number of rounds and the team size',
              daysBefore: 42,
            },
          ],
        },
        {
          heading: 'Venue',
          body: [
            'You need:',
            '- A projector or a large TV with an HDMI input, visible from every table',
            '- A microphone and a speaker for the quizmaster',
            '- Stable wifi or good mobile signal, since every team plays on a phone',
            '- Tables for the teams, and a power socket near the screen for the laptop',
            '- A step-free entrance and a step-free, gender-neutral toilet',
            '',
            'Test the screen and the connection at the venue a few days before, with the laptop you will use on the night.',
          ].join('\n'),
          steps: [
            {
              text: 'Confirm the venue in writing: screen, sound, wifi, tables and hours',
              daysBefore: 35,
            },
            {
              text: 'Test the screen and the wifi at the venue with the laptop for the night',
              daysBefore: 7,
            },
          ],
        },
        {
          heading: 'Questions',
          body: [
            'Start from a quiz in [Quiz templates](/admin/quizshow/templates) and adapt it, or plan your own rounds. A mix that works:',
            '- Queer culture and history',
            '- A music round with song intros',
            '- A picture round',
            '- A local round about Lisbon and its queer spaces',
            '- A wheel round, where the wheel picks the category',
            '',
            "Every answer needs a source, written in the quiz's staff notes. Keep the questions on culture and history, and leave out anything that guesses at a real person's identity or makes fun of one. If the crowd mixes Portuguese and English speakers, set the quiz to both languages.",
          ].join('\n'),
          steps: [
            {
              text: 'Pick a quiz in Quiz templates or plan the rounds from scratch',
              daysBefore: 28,
            },
            {
              text: 'Write or adapt the questions and add a source for every answer',
              daysBefore: 14,
            },
            {
              text: 'Ask another producer to fact-check every question',
              daysBefore: 7,
            },
            {
              text: 'Play the whole quiz once on the screen and the remote',
              daysBefore: 3,
            },
          ],
        },
        {
          heading: 'Hosts',
          body: [
            'Three roles, for three people or two:',
            '- The quizmaster reads each question twice, keeps the energy up and announces the scores between rounds.',
            "- The tech host runs Pulse Live from the event's Manage page, Live game tab: the screen on the projector and the remote on a phone.",
            '- The door host welcomes people, helps them join with the code on [the join page](/play), and forms teams for people who came alone.',
            '',
            'Pulse Live keeps the score, so nobody marks answer sheets.',
          ].join('\n'),
          steps: [
            {
              text: 'Confirm the quizmaster, the tech host and the door host',
              daysBefore: 14,
            },
            {
              text: "Rehearse with the tech host on the event's Live game tab",
              daysBefore: 3,
            },
          ],
        },
        {
          heading: 'Promotion',
          body: [
            "Publish the event on QueerPulse with the team size, the prizes, the access details and a line for newcomers: come alone and we'll find you a team.",
            '',
            "Share it in the communities that fit the night and in the team's channels. A sample question makes a good teaser a week before.",
          ].join('\n'),
          steps: [
            {
              text: 'Publish the event on QueerPulse with the team size, prizes and access details',
              daysBefore: 28,
            },
            {
              text: 'Share the event in the communities that fit the night',
              daysBefore: 21,
            },
            { text: 'Post a sample question as a teaser', daysBefore: 7 },
            { text: 'Post a last call', daysBefore: 1 },
          ],
        },
        {
          heading: 'The night itself',
          body: [
            'A timeline that works:',
            "- 18:30 The tech host sets up the laptop, opens the event's Manage page, Live game tab, puts the screen on the projector and opens the remote on a phone",
            '- 19:00 Doors open. The join code is on the screen and the door host helps teams join',
            '- 19:30 Round one',
            '- After round three, a fifteen-minute break',
            '- 21:15 Final round, then the scores and the prizes',
            '',
            'Answers go in on phones only, and teams keep search engines closed. The quizmaster reads every question out loud twice, so everyone can follow wherever they sit.',
          ].join('\n'),
          steps: [
            {
              text: 'Pack the laptop, the HDMI and power cables, a spare charger and the prizes',
              daysBefore: 0,
            },
            {
              text: 'Open the screen and the remote and check that the join code works',
              daysBefore: 0,
            },
          ],
        },
        {
          heading: 'Wrap-up',
          body: [
            'Announce the winners, take photos only of people who said yes, and thank everyone for coming.',
            '',
            'In the days after:',
            '- Thank the venue and the hosts',
            "- Note which questions worked and which flopped in the quiz's staff notes",
            '- Write down how many teams came and what to change, then add it as an idea or update this guide',
          ].join('\n'),
          steps: [
            { text: 'Thank the venue and the hosts', daysBefore: -1 },
            {
              text: "Note which questions worked in the quiz's staff notes",
              daysBefore: -2,
            },
            {
              text: 'Write down attendance and what to change, and update this guide',
              daysBefore: -3,
            },
          ],
        },
      ],
    },
    {
      id: 'c5a1e000-5eed-4000-8000-000000000004',
      title: 'Noite de quiz',
      eventType: 'quiz_night',
      locale: 'pt',
      summary:
        'Como o QueerPulse organiza uma noite de quiz no Pulse Live: as equipas respondem no telemóvel, as perguntas aparecem num ecrã grande, quem apresenta mantém a energia em alta e cada ronda é para toda a gente.',
      sections: [
        {
          heading: 'A noite em resumo',
          body: [
            'Equipas de duas a seis pessoas jogam cinco ou seis rondas em cerca de duas horas. As perguntas aparecem num projetor ou numa televisão e as equipas respondem no telemóvel através do Pulse Live, que também conta os pontos. Quem vem sem companhia junta-se a uma equipa à porta.',
            '',
            'Um bom quiz QueerPulse mistura cultura queer, música, imagens e uma ronda local sobre Lisboa, com perguntas fáceis e difíceis em cada ronda para que todas as equipas acompanhem.',
          ].join('\n'),
          steps: [
            {
              text: 'Escolhe a data, o número de rondas e o tamanho das equipas',
              daysBefore: 42,
            },
          ],
        },
        {
          heading: 'Espaço',
          body: [
            'Precisas de:',
            '- Um projetor ou uma televisão grande com entrada HDMI, visível de todas as mesas',
            '- Um microfone e uma coluna para quem apresenta',
            '- Wi-fi estável ou boa rede móvel, porque cada equipa joga num telemóvel',
            '- Mesas para as equipas e uma tomada perto do ecrã para o portátil',
            '- Entrada sem degraus e uma casa de banho sem degraus e para todos os géneros',
            '',
            'Testa o ecrã e a ligação no espaço uns dias antes, com o portátil que vais usar na noite.',
          ].join('\n'),
          steps: [
            {
              text: 'Confirma o espaço por escrito: ecrã, som, wi-fi, mesas e horário',
              daysBefore: 35,
            },
            {
              text: 'Testa o ecrã e o wi-fi no espaço com o portátil da noite',
              daysBefore: 7,
            },
          ],
        },
        {
          heading: 'Perguntas',
          body: [
            'Começa por um quiz em [Modelos de quiz](/admin/quizshow/templates) e adapta-o, ou planeia as tuas rondas. Uma mistura que funciona:',
            '- Cultura e história queer',
            '- Uma ronda de música com o início das canções',
            '- Uma ronda de imagens',
            '- Uma ronda local sobre Lisboa e os seus espaços queer',
            '- Uma ronda da roda, em que a roda escolhe a categoria',
            '',
            'Cada resposta precisa de uma fonte, escrita nas notas internas do quiz. Mantém as perguntas na cultura e na história, e deixa de fora tudo o que tente adivinhar a identidade de uma pessoa real ou goze com ela. Se o público misturar quem fala português e quem fala inglês, põe o quiz nas duas línguas.',
          ].join('\n'),
          steps: [
            {
              text: 'Escolhe um quiz em Modelos de quiz ou planeia as rondas do zero',
              daysBefore: 28,
            },
            {
              text: 'Escreve ou adapta as perguntas e junta uma fonte a cada resposta',
              daysBefore: 14,
            },
            {
              text: 'Pede a outra pessoa da produção que verifique cada pergunta',
              daysBefore: 7,
            },
            {
              text: 'Joga o quiz inteiro uma vez no ecrã e no comando',
              daysBefore: 3,
            },
          ],
        },
        {
          heading: 'Hosts',
          body: [
            'Três papéis, para três pessoas ou duas:',
            '- Quem apresenta lê cada pergunta duas vezes, mantém a energia e anuncia os pontos entre rondas.',
            '- Quem trata da parte técnica corre o Pulse Live a partir da página Gerir do evento, separador Jogo ao vivo: o ecrã no projetor e o comando num telemóvel.',
            '- A pessoa da porta recebe as pessoas, ajuda-as a entrar com o código na [página de entrada](/play) e forma equipas para quem veio sem companhia.',
            '',
            'O Pulse Live conta os pontos, por isso ninguém tem de corrigir folhas de respostas.',
          ].join('\n'),
          steps: [
            {
              text: 'Confirma quem apresenta, quem trata da parte técnica e a pessoa da porta',
              daysBefore: 14,
            },
            {
              text: 'Ensaia com quem trata da parte técnica no separador Jogo ao vivo do evento',
              daysBefore: 3,
            },
          ],
        },
        {
          heading: 'Divulgação',
          body: [
            'Publica o evento no QueerPulse com o tamanho das equipas, os prémios, os detalhes de acessibilidade e uma frase para quem vem pela primeira vez: vem sem companhia, nós encontramos-te uma equipa.',
            '',
            'Partilha-o nas comunidades que fazem sentido para a noite e nos canais da equipa. Uma pergunta de exemplo é um bom aperitivo uma semana antes.',
          ].join('\n'),
          steps: [
            {
              text: 'Publica o evento no QueerPulse com o tamanho das equipas, os prémios e os detalhes de acessibilidade',
              daysBefore: 28,
            },
            {
              text: 'Partilha o evento nas comunidades que fazem sentido para a noite',
              daysBefore: 21,
            },
            {
              text: 'Publica uma pergunta de exemplo como aperitivo',
              daysBefore: 7,
            },
            { text: 'Publica uma última chamada', daysBefore: 1 },
          ],
        },
        {
          heading: 'A noite',
          body: [
            'Um horário que funciona:',
            '- 18:30 Quem trata da parte técnica monta o portátil, abre a página Gerir do evento, separador Jogo ao vivo, põe o ecrã no projetor e abre o comando num telemóvel',
            '- 19:00 Abrem as portas. O código de entrada está no ecrã e a pessoa da porta ajuda as equipas a entrar',
            '- 19:30 Primeira ronda',
            '- Depois da terceira ronda, quinze minutos de intervalo',
            '- 21:15 Ronda final, depois os pontos e os prémios',
            '',
            'As respostas entram só pelo telemóvel e as equipas mantêm os motores de busca fechados. Quem apresenta lê cada pergunta em voz alta duas vezes, para que toda a gente acompanhe, esteja onde estiver na sala.',
          ].join('\n'),
          steps: [
            {
              text: 'Leva o portátil, os cabos HDMI e de alimentação, um carregador extra e os prémios',
              daysBefore: 0,
            },
            {
              text: 'Abre o ecrã e o comando e confirma que o código de entrada funciona',
              daysBefore: 0,
            },
          ],
        },
        {
          heading: 'Depois do evento',
          body: [
            'Anuncia quem ganhou, tira fotos só de quem disse que sim e agradece a toda a gente por ter vindo.',
            '',
            'Nos dias a seguir:',
            '- Agradece ao espaço e aos hosts',
            '- Regista nas notas internas do quiz que perguntas resultaram e quais falharam',
            '- Regista quantas equipas vieram e o que mudar, e junta isso como ideia ou atualiza este guia',
          ].join('\n'),
          steps: [
            { text: 'Agradece ao espaço e aos hosts', daysBefore: -1 },
            {
              text: 'Regista nas notas internas do quiz que perguntas resultaram',
              daysBefore: -2,
            },
            {
              text: 'Regista a afluência e o que mudar, e atualiza este guia',
              daysBefore: -3,
            },
          ],
        },
      ],
    },
  ];
