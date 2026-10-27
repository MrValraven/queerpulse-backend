/**
 * A frozen copy of the retired starter-pack catalog, generated on 2026-10-27 by
 * a one-off script that is no longer in the repo. It seeds
 * AddQuizshowTemplates1837900000000. Do not edit.
 */
export interface QuizshowTemplateSeed {
  id: string;
  packKey: string;
  cardTitle: { en: string; pt: string };
  cardDescription: { en: string; pt: string };
  staffNotes: string;
  quiz: {
    title: string;
    languages: 'en' | 'pt' | 'both';
    screenLanguage: 'en' | 'pt';
    rounds: Array<{
      kind: string;
      title: { en: string; pt: string };
      contentLabel: string;
      settings: Record<string, number | boolean>;
      questions: Array<Record<string, unknown>>;
    }>;
  };
}

export const QUIZSHOW_TEMPLATE_SEEDS_1837900000000: readonly QuizshowTemplateSeed[] =
  [
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000001',
      packKey: 'pride_history',
      cardTitle: {
        en: 'Pride and queer history',
        pt: 'Orgulho e história queer',
      },
      cardDescription: {
        en: 'The people and moments behind Pride around the world, and a round where you write the fake answers',
        pt: 'As pessoas e os momentos por trás do Orgulho pelo mundo, e uma ronda em que escreves as respostas falsas',
      },
      staffNotes:
        'Round 1, question 1: US National Park Service, Stonewall National Monument (nps.gov/ston): the Stonewall Inn, 53 Christopher Street, Greenwich Village.\nRound 1, question 2: MoMA collection, "Rainbow Flag" by Gilbert Baker (1978); Gilbert Baker Foundation.\nRound 1, question 3: Government of the Netherlands (government.nl), marriage open to same-sex couples since 1 April 2001; Wikipedia "Same-sex marriage in the Netherlands".\nRound 1, question 4: Pride in London history; British Library on the Gay Liberation Front: the first UK Pride march, London, 1 July 1972.\nRound 1, question 5: IDAHOBIT committee (may17.org); WHO: the World Health Assembly adopted ICD-10, without homosexuality as a disorder, on 17 May 1990.\nRound 1, question 6: Gilbert Baker Foundation; MoMA: the first rainbow flags flew at the San Francisco Gay Freedom Day Parade, 25 June 1978. Statement is false.\nRound 2, question 1: NYPL and Wikipedia "Street Transvestite Action Revolutionaries": STAR founded in 1970 by Sylvia Rivera and Marsha P. Johnson.\nRound 2, question 2: Library of Congress and NYPL: Christopher Street Liberation Day march, New York, 28 June 1970.\nRound 2, question 3: Library of Congress (New York, 1970); Gilbert Baker Foundation (San Francisco, 1978); EPOA, epoa.eu (first EuroPride, London, 1992); InterPride (first WorldPride, Rome, 2000).\nRound 2, question 4: Wikipedia country pages on same-sex marriage: Belgium 1 June 2003, South Africa 30 November 2006, Argentina 22 July 2010, Ireland 16 November 2015.\nRound 2, question 5: Gilbert Baker Foundation; MoMA: the 1978 flag had eight stripes (hot pink, red, orange, yellow, green, turquoise, indigo, violet).\nRound 2, question 6: Wikipedia "Registered partnership in Denmark": the Registered Partnership Act took effect on 1 October 1989.\nRound 3, question 1: Gilbert Baker Foundation; MoMA: Baker gave each stripe a meaning, and violet stood for spirit.\nRound 3, question 2: Wikipedia "Annual Reminder"; Pennsylvania Historical and Museum Commission marker "Gay Rights Demonstrations" at Independence Hall: pickets every 4 July from 1965 to 1969.\nRound 3, question 3: Marsha P. Johnson Institute; New York Times "Overlooked No More: Marsha P. Johnson" (2018): she said the P stood for "Pay It No Mind".',
      quiz: {
        title: 'Pride and queer history',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'quiz',
            title: {
              en: 'Where it started',
              pt: 'Onde tudo começou',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'The Stonewall Inn, where the June 1969 uprising began, stands in which New York neighbourhood?',
                  pt: 'O Stonewall Inn, onde começou a revolta de junho de 1969, fica em que bairro de Nova Iorque?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Harlem',
                      pt: 'Harlem',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Greenwich Village',
                      pt: 'Greenwich Village',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Brooklyn Heights',
                      pt: 'Brooklyn Heights',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Upper East Side',
                      pt: 'Upper East Side',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who designed the original rainbow Pride flag?',
                  pt: 'Quem desenhou a bandeira arco-íris original do Orgulho?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Harvey Milk',
                      pt: 'Harvey Milk',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Monica Helms',
                      pt: 'Monica Helms',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Gilbert Baker',
                      pt: 'Gilbert Baker',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Daniel Quasar',
                      pt: 'Daniel Quasar',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which country became the first to open civil marriage to same-sex couples, on 1 April 2001?',
                  pt: 'Que país foi o primeiro a abrir o casamento civil a casais do mesmo sexo, a 1 de abril de 2001?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'The Netherlands',
                      pt: 'Países Baixos',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Denmark',
                      pt: 'Dinamarca',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Belgium',
                      pt: 'Bélgica',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Canada',
                      pt: 'Canadá',
                    },
                  },
                ],
                answer: {
                  correctIndex: 0,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In which year did London hold the first Pride march in the UK?',
                  pt: 'Em que ano se realizou em Londres a primeira marcha do Orgulho do Reino Unido?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: '1969',
                      pt: '1969',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: '1981',
                      pt: '1981',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: '1990',
                      pt: '1990',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: '1972',
                      pt: '1972',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'IDAHOBIT falls on 17 May because on that day in 1990 the World Health Organization removed homosexuality from its list of mental disorders',
                  pt: 'O IDAHOBIT assinala-se a 17 de maio porque nesse dia, em 1990, a Organização Mundial da Saúde retirou a homossexualidade da sua lista de perturbações mentais',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'The rainbow flag was first flown in New York, at the 1970 Pride march',
                  pt: 'A bandeira arco-íris foi hasteada pela primeira vez em Nova Iorque, na marcha do Orgulho de 1970',
                },
                options: [],
                answer: {
                  isTrue: false,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Names and dates',
              pt: 'Nomes e datas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'Which activist co-founded the group STAR in 1970 with her friend Marsha P. Johnson?',
                  pt: 'Que ativista fundou o grupo STAR em 1970 com a amiga Marsha P. Johnson?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Sylvia Rivera',
                    pt: 'Sylvia Rivera',
                  },
                },
                acceptedAnswers: ['Rivera', 'Sylvia'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Fill in the name of the first New York Pride march, on 28 June 1970: Christopher Street ___ Day',
                  pt: 'Completa o nome da primeira marcha do Orgulho de Nova Iorque, a 28 de junho de 1970: Christopher Street ___ Day',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Liberation',
                    pt: 'Liberation',
                  },
                },
                acceptedAnswers: ['Libertação', 'Liberation Day'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these Pride firsts in order, earliest first',
                  pt: 'Põe estes marcos do Orgulho por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'First Pride march in New York',
                      pt: 'Primeira marcha do Orgulho em Nova Iorque',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'First rainbow flags fly in San Francisco',
                      pt: 'Primeiras bandeiras arco-íris em São Francisco',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'First EuroPride, in London',
                      pt: 'Primeiro EuroPride, em Londres',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'First WorldPride, in Rome',
                      pt: 'Primeiro WorldPride, em Roma',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these countries in the order they opened marriage to same-sex couples, earliest first',
                  pt: 'Põe estes países pela ordem em que abriram o casamento a casais do mesmo sexo, do primeiro para o último',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Belgium',
                      pt: 'Bélgica',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'South Africa',
                      pt: 'África do Sul',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Argentina',
                      pt: 'Argentina',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Ireland',
                      pt: 'Irlanda',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "How many stripes did Gilbert Baker's original 1978 rainbow flag have?",
                  pt: 'Quantas riscas tinha a bandeira arco-íris original de Gilbert Baker, de 1978?',
                },
                options: [],
                answer: {
                  value: 8,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year did Denmark become the first country to offer registered partnerships to same-sex couples?',
                  pt: 'Em que ano é que a Dinamarca se tornou o primeiro país a criar uniões registadas para casais do mesmo sexo?',
                },
                options: [],
                answer: {
                  value: 1989,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Lie Detector',
              pt: 'Detetor de mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: "On Gilbert Baker's original rainbow flag, what did the violet stripe stand for?",
                  pt: 'Na bandeira arco-íris original de Gilbert Baker, o que representava a risca violeta?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Spirit',
                    pt: 'Espírito',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'What was the yearly 4 July gay rights picket outside Independence Hall in Philadelphia, held from 1965 to 1969, called?',
                  pt: 'Como se chamava, em inglês, o protesto anual pelos direitos gay, a cada 4 de julho entre 1965 e 1969, à porta do Independence Hall, em Filadélfia?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'The Annual Reminder',
                    pt: 'Annual Reminder',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'Activist Marsha Johnson went by Marsha P, what did she say the P stood for?',
                  pt: 'A ativista Marsha Johnson usava o nome Marsha P, o que dizia ela que significava o P?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Pay It No Mind',
                    pt: 'Pay It No Mind',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
        ],
      },
    },
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000002',
      packKey: 'portuguese_queer_culture',
      cardTitle: {
        en: 'Portuguese queer culture and history',
        pt: 'Cultura e história queer portuguesa',
      },
      cardDescription: {
        en: 'From the 1982 decriminalisation to the arraial, with a round of fake answers to spot',
        pt: 'Da descriminalização de 1982 ao arraial, com uma ronda de respostas falsas para apanhar',
      },
      staffNotes:
        'Round 1, question 1: Decreto-Lei n.º 400/82 of 23 September 1982 (Diário da República) approved the Penal Code that took effect on 1 January 1983; ILGA Portugal history. CHECK: the answer is the approval year 1982.\nRound 1, question 2: Infopédia "António Variações"; RTP Gramofone: "O corpo é que paga" is on Anjo da Guarda (1983). Distractors: Zeca Afonso, Amália Rodrigues, Salvador Sobral.\nRound 1, question 3: queerlisboa.pt; Wikipedia "Queer Lisboa International Queer Film Festival": first edition 13 September 1997.\nRound 1, question 4: Lei Constitucional n.º 1/2004 (Diário da República) added sexual orientation to article 13, n.º 2 (principle of equality) of the Constitution.\nRound 1, question 5: ilga-portugal.pt "Who we are" and its activity plans: founded in 1995, legally registered in 1996.\nRound 1, question 6: Lei n.º 9/2010 of 31 May 2010 (Portugal, in force 5 June 2010); Ley 13/2005 (Spain, in force 3 July 2005). Statement is false.\nRound 2, question 1: Wikipedia "Lisbon Pride"; CIG, cig.gov.pt: the Arraial Lisboa Pride, organised by ILGA Portugal within the Festas de Lisboa, has run every year since 1997 (the 1997 and 1998 editions at Jardim do Príncipe Real; Terreiro do Paço in recent years).\nRound 2, question 2: Wikipedia "António Botto"; Arquivo Modernismo (modernismo.pt): Pessoa\'s Olisipo published the second edition of Canções in 1922.\nRound 2, question 3: Lei n.º 7/2001 (uniões de facto), Lei n.º 9/2010 (marriage), Lei n.º 2/2016 (adoption), Lei n.º 38/2018 (gender self-determination), all in the Diário da República.\nRound 2, question 4: modernismo.pt (Canções, Olisipo, 1922); Infopédia (Anjo da Guarda, 1983); queerlisboa.pt (first edition 1997); the film Variações by João Maia opened in Portuguese cinemas on 22 August 2019 (DNoticias).\nRound 2, question 5: Wikipedia "Lisbon Pride"; Time Out Lisboa: the first Marcha do Orgulho LGBT in Lisbon was on 28 June 2000.\nRound 2, question 6: PortugalGay.pt photo report "Porto 2006" (first Marcha do Orgulho LGBT do Porto, 8 July 2006); Sábado and RTP coverage of the 2026 march marking 20 years since the first.\nRound 3, question 1: Observador; RTP Gramofone; Correio da Manhã: before music he worked as a barber and in a unisex hairdressing salon, in Lisbon and abroad.\nRound 3, question 2: Wikipedia "Queer Lisboa International Queer Film Festival"; Time Out Lisboa "10 curiosidades sobre o Queer Lisboa": first edition 1997 as the Lisbon Gay and Lesbian Film Festival.\nRound 3, question 3: ilga-portugal.pt: the full name is ILGA Portugal, Intervenção Lésbica, Gay, Bissexual, Trans e Intersexo (English page: "Lesbian, Gay, Bisexual, Trans and Intersex Intervention").',
      quiz: {
        title: 'Cultura e história queer portuguesa',
        languages: 'both',
        screenLanguage: 'pt',
        rounds: [
          {
            kind: 'quiz',
            title: {
              en: 'Milestones',
              pt: 'Marcos',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In which year was the Penal Code that decriminalised homosexuality in Portugal approved?',
                  pt: 'Em que ano foi aprovado o Código Penal que descriminalizou a homossexualidade em Portugal?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: '1974',
                      pt: '1974',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: '1982',
                      pt: '1982',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: '1990',
                      pt: '1990',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: '2001',
                      pt: '2001',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which of these songs is by António Variações?',
                  pt: 'Qual destas canções é de António Variações?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Grândola, Vila Morena',
                      pt: 'Grândola, Vila Morena',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Uma casa portuguesa',
                      pt: 'Uma casa portuguesa',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'O corpo é que paga',
                      pt: 'O corpo é que paga',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Amar pelos dois',
                      pt: 'Amar pelos dois',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which Lisbon film festival, first held in 1997, is dedicated to queer cinema?',
                  pt: 'Que festival de cinema de Lisboa, com primeira edição em 1997, é dedicado ao cinema queer?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'IndieLisboa',
                      pt: 'IndieLisboa',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Queer Lisboa',
                      pt: 'Queer Lisboa',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Doclisboa',
                      pt: 'Doclisboa',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'MONSTRA',
                      pt: 'MONSTRA',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In 2004, sexual orientation was added to the equality article of which Portuguese text?',
                  pt: 'Em 2004, a orientação sexual foi acrescentada ao artigo da igualdade de que texto português?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'The Constitution',
                      pt: 'A Constituição',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Civil Code',
                      pt: 'O Código Civil',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Highway Code',
                      pt: 'O Código da Estrada',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The national anthem',
                      pt: 'O hino nacional',
                    },
                  },
                ],
                answer: {
                  correctIndex: 0,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'ILGA Portugal was founded in 1995',
                  pt: 'A ILGA Portugal foi fundada em 1995',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Portugal opened civil marriage to same-sex couples before Spain did',
                  pt: 'Portugal abriu o casamento civil a casais do mesmo sexo antes de Espanha',
                },
                options: [],
                answer: {
                  isTrue: false,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Names and dates',
              pt: 'Nomes e datas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: "Lisbon's big yearly Pride party in June is named after Portugal's traditional summer street festivals, what is it called?",
                  pt: 'A grande festa anual do Orgulho em Lisboa, em junho, tem o nome das festas populares de verão, sabes como se chama?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Arraial Lisboa Pride',
                    pt: 'Arraial Lisboa Pride',
                  },
                },
                acceptedAnswers: [
                  'Arraial',
                  'Arraial Pride',
                  'Arraial Pride Lisboa',
                ],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: "In 1922, Fernando Pessoa's publishing house Olisipo brought out a new edition of the poetry book Canções, who wrote it?",
                  pt: 'Em 1922, a editora Olisipo, de Fernando Pessoa, publicou uma nova edição do livro de poemas Canções, quem o escreveu?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'António Botto',
                    pt: 'António Botto',
                  },
                },
                acceptedAnswers: ['Botto'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these Portuguese laws in order, earliest first',
                  pt: 'Põe estas leis portuguesas por ordem, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'De facto unions open to same-sex couples',
                      pt: 'Uniões de facto abertas a casais do mesmo sexo',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Civil marriage for same-sex couples',
                      pt: 'Casamento civil entre pessoas do mesmo sexo',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Adoption by same-sex couples',
                      pt: 'Adoção por casais do mesmo sexo',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Self-determination of gender identity',
                      pt: 'Autodeterminação da identidade de género',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these moments of Portuguese queer culture in order, earliest first',
                  pt: 'Põe estes momentos da cultura queer portuguesa por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: "Pessoa's Olisipo publishes Botto's Canções",
                      pt: 'A Olisipo de Pessoa publica as Canções de Botto',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Variações releases his first album, Anjo da Guarda',
                      pt: 'Variações lança o primeiro álbum, Anjo da Guarda',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: "Lisbon's queer film festival holds its first edition",
                      pt: 'O festival de cinema queer de Lisboa tem a primeira edição',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The biopic Variações opens in cinemas',
                      pt: 'O filme Variações estreia nos cinemas',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year did Lisbon hold its first Pride march, the Marcha do Orgulho?',
                  pt: 'Em que ano se realizou a primeira Marcha do Orgulho de Lisboa?',
                },
                options: [],
                answer: {
                  value: 2000,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year did Porto hold its first Pride march, the Marcha do Orgulho?',
                  pt: 'Em que ano se realizou a primeira Marcha do Orgulho do Porto?',
                },
                options: [],
                answer: {
                  value: 2006,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Lie Detector',
              pt: 'Detetor de mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'What did António Variações do for a living before he became a pop star?',
                  pt: 'Qual era a profissão de António Variações antes de ser estrela pop?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Barber and hairdresser',
                    pt: 'Barbeiro e cabeleireiro',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'What was Queer Lisboa called at its first edition in 1997?',
                  pt: 'Como se chamava o Queer Lisboa na primeira edição, em 1997?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Lisbon Gay and Lesbian Film Festival',
                    pt: 'Festival de Cinema Gay e Lésbico de Lisboa',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: "ILGA Portugal's full name starts with which Portuguese word (it means Intervention), before Lésbica, Gay, Bissexual, Trans e Intersexo?",
                  pt: 'O nome completo da ILGA Portugal começa por que palavra, antes de Lésbica, Gay, Bissexual, Trans e Intersexo?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Intervenção',
                    pt: 'Intervenção',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
        ],
      },
    },
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000003',
      packKey: 'eurovision',
      cardTitle: {
        en: 'Eurovision',
        pt: 'Eurovisão',
      },
      cardDescription: {
        en: 'Winners, legends and the songs everyone knows, and a round where you write the fake answers',
        pt: 'Vencedores, lendas e as canções que toda a gente sabe, e uma ronda em que escreves as respostas falsas',
      },
      staffNotes:
        'Round 1, question 1: eurovision.tv, Brighton 1974: Sweden, ABBA, "Waterloo".\nRound 1, question 2: eurovision.tv, Birmingham 1998: Israel, Dana International, "Diva".\nRound 1, question 3: eurovision.tv, Copenhagen 2014: Austria, Conchita Wurst, "Rise Like a Phoenix". Distractors: Loreen 2012, Alexander Rybak 2009, Måns Zelmerlöw 2015.\nRound 1, question 4: eurovision.tv, Lisbon 2018 (Altice Arena), hosted by Portugal after its 2017 win.\nRound 1, question 5: eurovision.tv, Malmö 2024: Switzerland, Nemo, "The Code".\nRound 1, question 6: eurovision.tv, Kyiv 2017: Portugal, Salvador Sobral, "Amar pelos dois", sung in Portuguese. Statement is false.\nRound 2, question 1: eurovision.tv, Lugano 1956: the first contest, hosted and won by Switzerland.\nRound 2, question 2: eurovision.tv, Liverpool 2023: Sweden, Loreen, "Tattoo"; her second win after "Euphoria" in 2012.\nRound 2, question 3: eurovision.tv winners: Céline Dion for Switzerland 1988, Lordi for Finland 2006, Loreen for Sweden 2012, Måneskin for Italy 2021.\nRound 2, question 4: eurovision.tv host cities, most recent contest of each: Copenhagen 2014, Stockholm 2016, Tel Aviv 2019, Liverpool 2023.\nRound 2, question 5: eurovision.tv, Lugano, 24 May 1956.\nRound 2, question 6: eurovision.tv, Kyiv 2017 scoreboard: Portugal won with 758 points.\nRound 3, question 1: eurovision.tv, Birmingham 1998: Dana International won with "Diva".\nRound 3, question 2: eurovision.tv and BBC News coverage of the 2014 final: her winner\'s speech closed with "We are unity and we are unstoppable".\nRound 3, question 3: eurovision.tv "The trophy": since 2008 the winner receives a glass microphone designed by Kjell Engman of Kosta Boda.',
      quiz: {
        title: 'Eurovision',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'quiz',
            title: {
              en: 'Winners and legends',
              pt: 'Vencedores e lendas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'With which song did ABBA win Eurovision in 1974?',
                  pt: 'Com que canção é que os ABBA venceram a Eurovisão em 1974?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Mamma Mia',
                      pt: 'Mamma Mia',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Waterloo',
                      pt: 'Waterloo',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Dancing Queen',
                      pt: 'Dancing Queen',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'SOS',
                      pt: 'SOS',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which country did Dana International represent when she won Eurovision in 1998?',
                  pt: 'Que país representava Dana International quando venceu a Eurovisão em 1998?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Malta',
                      pt: 'Malta',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Greece',
                      pt: 'Grécia',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Cyprus',
                      pt: 'Chipre',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Israel',
                      pt: 'Israel',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'With which song did Conchita Wurst win Eurovision in 2014?',
                  pt: 'Com que canção é que Conchita Wurst venceu a Eurovisão em 2014?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Euphoria',
                      pt: 'Euphoria',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Fairytale',
                      pt: 'Fairytale',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Rise Like a Phoenix',
                      pt: 'Rise Like a Phoenix',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Heroes',
                      pt: 'Heroes',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "After Salvador Sobral's 2017 win, which city hosted Eurovision 2018?",
                  pt: 'Depois da vitória de Salvador Sobral em 2017, que cidade recebeu a Eurovisão de 2018?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Lisbon',
                      pt: 'Lisboa',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Porto',
                      pt: 'Porto',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Coimbra',
                      pt: 'Coimbra',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Faro',
                      pt: 'Faro',
                    },
                  },
                ],
                answer: {
                  correctIndex: 0,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Nemo won Eurovision 2024 for Switzerland with the song The Code',
                  pt: 'Nemo venceu a Eurovisão de 2024 pela Suíça com a canção The Code',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Salvador Sobral sang his winning song Amar pelos dois in English',
                  pt: 'Salvador Sobral cantou a canção vencedora, Amar pelos dois, em inglês',
                },
                options: [],
                answer: {
                  isTrue: false,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Numbers and names',
              pt: 'Números e nomes',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'Which country hosted the very first Eurovision Song Contest?',
                  pt: 'Que país recebeu o primeiro Festival Eurovisão da Canção?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Switzerland',
                    pt: 'Suíça',
                  },
                },
                acceptedAnswers: ['Suisse', 'Schweiz', 'Svizzera'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'In 2023 Loreen became the first woman to win Eurovision twice, with which song?',
                  pt: 'Em 2023, Loreen tornou-se a primeira mulher a vencer a Eurovisão duas vezes, com que canção?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Tattoo',
                    pt: 'Tattoo',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these winners in order, earliest first',
                  pt: 'Põe estas vitórias por ordem, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Céline Dion, Ne partez pas sans moi',
                      pt: 'Céline Dion, Ne partez pas sans moi',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Lordi, Hard Rock Hallelujah',
                      pt: 'Lordi, Hard Rock Hallelujah',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Loreen, Euphoria',
                      pt: 'Loreen, Euphoria',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Måneskin, Zitti e buoni',
                      pt: 'Måneskin, Zitti e buoni',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these host cities in the order of their most recent contest, earliest first',
                  pt: 'Põe estas cidades anfitriãs pela ordem do festival mais recente que cada uma recebeu, da primeira para a última',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Copenhagen',
                      pt: 'Copenhaga',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Stockholm',
                      pt: 'Estocolmo',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Tel Aviv',
                      pt: 'Telavive',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Liverpool',
                      pt: 'Liverpool',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year was the first Eurovision Song Contest held?',
                  pt: 'Em que ano se realizou o primeiro Festival Eurovisão da Canção?',
                },
                options: [],
                answer: {
                  value: 1956,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How many points did Amar pelos dois score when it won in 2017?',
                  pt: 'Quantos pontos fez Amar pelos dois quando venceu em 2017?',
                },
                options: [],
                answer: {
                  value: 758,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Lie Detector',
              pt: 'Detetor de mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: "What was the title of Dana International's winning song in 1998?",
                  pt: 'Qual era o título da canção vencedora de Dana International em 1998?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Diva',
                    pt: 'Diva',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: "What was the last word of Conchita Wurst's 2014 winner's speech, after 'We are unity and we are'?",
                  pt: "Qual foi a última palavra, em inglês, do discurso de vitória de Conchita Wurst em 2014, depois de 'We are unity and we are'?",
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Unstoppable',
                    pt: 'Unstoppable',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: "Since 2008, what has the Eurovision winner's trophy looked like?",
                  pt: 'Desde 2008, qual é a forma do troféu de quem vence a Eurovisão?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'A glass microphone',
                    pt: 'Um microfone de vidro',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
        ],
      },
    },
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000004',
      packKey: 'drag_herstory',
      cardTitle: {
        en: 'Drag herstory',
        pt: 'Herstory do drag',
      },
      cardDescription: {
        en: 'Queens, ballroom and the shows that made them, and a drag name round',
        pt: 'Rainhas, ballroom e os programas que os tornaram famosos, e uma ronda de nomes drag',
      },
      staffNotes:
        'Round 1, question 1: Wikipedia "RuPaul\'s Drag Race season 1" (Logo, 2009): BeBe Zahara Benet won; Nina Flowers was runner-up.\nRound 1, question 2: BFI and Wikipedia "Pink Flamingos" (1972, John Waters, starring Divine). Distractors: Hairspray 1988, Polyester 1981, Cry-Baby 1990.\nRound 1, question 3: Library of Congress National Film Registry (2016 entry): Paris Is Burning, directed by Jennie Livingston.\nRound 1, question 4: Paris Is Burning (1990); Smithsonian National Museum of African American History and Culture on ballroom culture: houses are chosen families led by a mother or father.\nRound 1, question 5: Smithsonian and Billboard on "Vogue" (1990): Madonna drew the dance from the vogueing of the New York ballroom scene.\nRound 1, question 6: Wikipedia "RuPaul\'s Drag Race": premiered on Logo on 2 February 2009, later moving to VH1 and MTV. Statement is false.\nRound 2, question 1: RuPaul\'s Drag Race (Logo, VH1, MTV), every season: "Sashay away" sends a queen home after the lip sync.\nRound 2, question 2: The Queen (1968 documentary); New York Times and Wikipedia "Crystal LaBeija": she founded the House of LaBeija.\nRound 2, question 3: BFI and Wikipedia film pages: La Cage aux Folles (1978), Hairspray (1988), The Adventures of Priscilla, Queen of the Desert (1994); Pose premiered on FX on 3 June 2018.\nRound 2, question 4: Wikipedia franchise pages: RuPaul\'s Drag Race 2009, All Stars 2012, Drag Race UK 2019 (BBC Three), Drag Race España 2021 (Atresplayer).\nRound 2, question 5: Wikipedia "RuPaul\'s Drag Race season 1": nine contestants.\nRound 2, question 6: BFI and Wikipedia "Divine (performer)": born 19 October 1945 in Baltimore.\nRound 3, question 1: none needed, a word game with no facts in it.\nRound 3, question 2: none needed, a word game with no facts in it.\nRound 3, question 3: none needed, a word game with no facts in it.',
      quiz: {
        title: 'Drag herstory',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'quiz',
            title: {
              en: 'Queens and legends',
              pt: 'Rainhas e lendas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: "Who won the first season of RuPaul's Drag Race?",
                  pt: "Quem venceu a primeira temporada de RuPaul's Drag Race?",
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Nina Flowers',
                      pt: 'Nina Flowers',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'BeBe Zahara Benet',
                      pt: 'BeBe Zahara Benet',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Shannel',
                      pt: 'Shannel',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Rebecca Glasscock',
                      pt: 'Rebecca Glasscock',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which 1972 John Waters film starred Divine?',
                  pt: 'Que filme de John Waters, de 1972, teve Divine como protagonista?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Hairspray',
                      pt: 'Hairspray',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Polyester',
                      pt: 'Polyester',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Pink Flamingos',
                      pt: 'Pink Flamingos',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Cry-Baby',
                      pt: 'Cry-Baby',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who directed the ballroom documentary Paris Is Burning?',
                  pt: 'Quem realizou o documentário sobre o ballroom Paris Is Burning?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'John Waters',
                      pt: 'John Waters',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Spike Lee',
                      pt: 'Spike Lee',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Gus Van Sant',
                      pt: 'Gus Van Sant',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Jennie Livingston',
                      pt: 'Jennie Livingston',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In ballroom culture, what is a house?',
                  pt: 'Na cultura ballroom, o que é uma house?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'A chosen family led by a mother or father',
                      pt: 'Uma família escolhida, liderada por uma mãe ou um pai',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The club where every ball takes place',
                      pt: 'O clube onde se fazem todos os bailes',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'A style of runway walk',
                      pt: 'Um estilo de desfile',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The judging panel',
                      pt: 'O painel de jurados',
                    },
                  },
                ],
                answer: {
                  correctIndex: 0,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "Madonna's 1990 hit Vogue took its dance from New York's ballroom scene",
                  pt: 'O êxito Vogue, de Madonna, em 1990, foi buscar a dança à cena ballroom de Nova Iorque',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "RuPaul's Drag Race first aired on MTV",
                  pt: "RuPaul's Drag Race estreou na MTV",
                },
                options: [],
                answer: {
                  isTrue: false,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Names and dates',
              pt: 'Nomes e datas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'What does RuPaul say to the queen who leaves the competition after a lip sync?',
                  pt: 'O que diz RuPaul à queen que sai da competição depois de um lip sync?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Sashay away',
                    pt: 'Sashay away',
                  },
                },
                acceptedAnswers: ['Sashay', 'Now sashay away'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Crystal LaBeija founded which ballroom house?',
                  pt: 'Que house do ballroom fundou Crystal LaBeija?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'House of LaBeija',
                    pt: 'House of LaBeija',
                  },
                },
                acceptedAnswers: ['LaBeija', 'Casa LaBeija', 'LaBeija House'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these drag moments on screen in order, earliest first',
                  pt: 'Põe estes momentos do drag no ecrã por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'La Cage aux Folles, the film',
                      pt: 'O filme La Cage aux Folles',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Hairspray, starring Divine',
                      pt: 'Hairspray, com Divine',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Adventures of Priscilla, Queen of the Desert',
                      pt: 'Priscilla, Rainha do Deserto',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Pose, the TV series',
                      pt: 'A série Pose',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these Drag Race premieres in order, earliest first',
                  pt: 'Põe estas estreias de Drag Race por ordem, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: "RuPaul's Drag Race",
                      pt: "RuPaul's Drag Race",
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: "RuPaul's Drag Race All Stars",
                      pt: "RuPaul's Drag Race All Stars",
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: "RuPaul's Drag Race UK",
                      pt: "RuPaul's Drag Race UK",
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Drag Race España',
                      pt: 'Drag Race España',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "How many queens competed in the first season of RuPaul's Drag Race?",
                  pt: "Quantas queens competiram na primeira temporada de RuPaul's Drag Race?",
                },
                options: [],
                answer: {
                  value: 9,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year was Divine born?',
                  pt: 'Em que ano nasceu Divine?',
                },
                options: [],
                answer: {
                  value: 1945,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'drag_name',
            title: {
              en: 'Drag Name Generator',
              pt: 'Gerador de nomes drag',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Your drag name is your favourite dessert plus the weather outside right now, what is it?',
                  pt: 'O teu nome drag é a tua sobremesa favorita mais o tempo que está lá fora agora, qual é?',
                },
                options: [],
                answer: null,
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'Turn your favourite snack into a drag name with a glamorous surname',
                  pt: 'Transforma o teu petisco favorito num nome drag com um apelido glamoroso',
                },
                options: [],
                answer: null,
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'Make a drag name from the last thing you bought',
                  pt: 'Cria um nome drag a partir da última coisa que compraste',
                },
                options: [],
                answer: null,
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
        ],
      },
    },
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000005',
      packKey: 'lisbon_queer_icons',
      cardTitle: {
        en: 'Queer Lisbon and Portuguese icons',
        pt: 'Lisboa queer e ícones portugueses',
      },
      cardDescription: {
        en: 'From the Inquisition to the drag houses of Príncipe Real: banned poets, Cannes stars and queer fado, with a round of fake answers to spot',
        pt: 'Da Inquisição às casas de drag do Príncipe Real: poetas proibidos, estrelas de Cannes e fado queer, com uma ronda de respostas falsas para apanhar',
      },
      staffNotes:
        'Round 1, question 1: Infopédia "Palácio dos Estaus": built in 1449 on the north side of Rossio, seat of the Lisbon Inquisition, burned in 1836; the Teatro Nacional D. Maria II was built on the site (1842 to 1846). Mott and Assunção, Journal of Homosexuality 16 (1989), on the Inquisition\'s sodomy trials.\nRound 1, question 2: Joana Matias, "Cravos cor-de-rosa", Revista Crítica de Ciências Sociais 133 (2024); Público "Pioneiros LGBT": the MAHR (Movimento de Acção Homossexual Revolucionária) manifesto "Liberdade para as minorias sexuais" ran in the Diário de Lisboa on 13 May 1974. Público also names the Diário Popular, so that title stays out of the options.\nRound 1, question 3: Time Out Lisboa, "Finalmente reabriu o Finalmente" (2020): open since 1976 at Rua da Palmeira 38, its drag shows are "os mais antigos de Lisboa"; Público "Pioneiros LGBT" dates Finalmente to 1976 and Trumps to 1980.\nRound 1, question 4: José Barreto, "Fernando Pessoa e Raul Leal contra a campanha moralizadora dos estudantes em 1923", Pessoa Plural 2 (2012); Wikipedia "Judite Teixeira": in March 1923 the civil governor, Major Viriato Lobo, had Botto\'s Canções, Leal\'s Sodoma Divinizada and Teixeira\'s Decadência seized and burned. Distractors: Florbela Espanca, Natália Correia (born 1923), Sophia de Mello Breyner Andresen (born 1919).\nRound 1, question 5: José Barreto, Pessoa Plural 2 (2012): the 1923 campaign was run by the Liga de Acção dos Estudantes de Lisboa, led by Pedro Teotónio Pereira; Pessoa answered it with "Aviso por causa da moral" (signed Álvaro de Campos) and "Sobre um manifesto de estudantes". Statement is false.\nRound 1, question 6: RTP, homage to Valentim de Barros on World Theatre Day (March 2025); Observador (29 December 2019): the dancer was held at the Hospital Miguel Bombarda because of his homosexuality, from 1939 until his death in 1986; in March 2025 the Teatro Nacional D. Maria II opened the Sala Estúdio Valentim de Barros in the Jardins do Bombarda.\nRound 2, question 1: Festival de Cannes 2009, Un Certain Regard: "Mourir comme un homme" by João Pedro Rodrigues; NZIFF 2010 cast list (Fernando Santos as Tónia); Time Out Lisboa: Fernando Santos is Deborah Kristall of Finalmente. Distractors: O Fantasma (Rodrigues, 2000), Tabu (Miguel Gomes, 2012), Variações (João Maia, 2019).\nRound 2, question 2: Museu do Fado "Ary dos Santos": lyrics of Desfolhada (Simone de Oliveira, Eurovision 1969) and Tourada (Fernando Tordo, Eurovision 1973); CM Jornal "Ary dos Santos sem papas na língua" on his "assumida homossexualidade"; the chapter "Poeta castrado, não!" in Beyond Binaries (Peter Lang, 2019). CHECK: his place in a queer icons pack rests on these two sources.\nRound 2, question 3: Cambridge University Library language collections blog, "Mário Cesariny: between us and words" (2018); DN, "Mário Cesariny, um homem aceso como um barco": "You are welcome to Elsinore" is in Pena Capital (1957). Distractors: Mensagem (Pessoa, 1934), O Medo (Al Berto, 1987), Canções (Botto).\nRound 2, question 4: Migalhas/AFP (May 2010): President Cavaco Silva promulgated the marriage law (Lei n.º 9/2010) on 17 May 2010, the International Day Against Homophobia, while saying he disagreed with it.\nRound 2, question 5: Wikipedia "List of LGBTQ politicians in Portugal"; Observador (4 June 2020): the anthropologist Miguel Vale de Almeida, elected in September 2009 as an independent on the PS list, was the first openly gay member of the Assembleia da República.\nRound 2, question 6: José Barreto, Pessoa Plural 2 (2012): "Aviso por causa da moral" is signed "Europa, 1923 / Álvaro de Campos".\nRound 2, question 7: Notícias ao Minuto (2022), "Ocupação: Fado Bicha lança primeiro álbum": formed in March 2017 by Lila Fadista with the guitarist João Caçador; Time Out Lisboa, "Fado Bicha: nós estamos vivas".\nRound 3, question 1: Wikipedia PT "António Variações": died in Lisbon on 13 June 1984; 13 June is the feast of Santo António, Lisbon\'s municipal holiday.\nRound 3, question 2: Time Out Lisboa (Finalmente opened in 1976; "36 coisas que precisa de saber sobre o Trumps": opened 11 December 1980); ilga-portugal.pt (founded 1995); Sábado and Observador (EuroPride in Lisbon, 14 to 22 June 2025, the first in Portugal).\nRound 3, question 3: Diário da República: Lei n.º 59/2007 of 4 September (equal age of consent, ends article 175), Lei n.º 7/2011 of 15 March (gender identity at the civil registry), Lei n.º 17/2016 of 20 June (assisted reproduction for all women), Lei n.º 15/2024 of 29 January (ban on conversion practices).\nRound 3, question 4: glbtq Encyclopedia "Portugal" (O Barão de Lavos, Abel Botelho, 1891); José Barreto, Pessoa Plural 2 (2012) (Canções seized, March 1923); Joana Matias, Revista Crítica de Ciências Sociais 133 (2024) (MAHR manifesto, 13 May 1974); The Advocate and CTV News (Teresa Pires and Helena Paixão marry at a Lisbon registry office, 7 June 2010).\nRound 3, question 5: José Barreto, Pessoa Plural 2 (2012); Wikipedia "Raul Leal": Olisipo printed 350 copies of Sodoma Divinizada in February 1923.\nRound 3, question 6: Visit Lisboa, "A árvore centenária do Príncipe Real"; ICNF Despacho n.º 8496/2018 (Tree of Public Interest): the Cupressus lusitanica (cedro-do-buçaco), trained flat over an iron frame, has a canopy about 22 metres across.\nRound 4, question 1: Time Out Lisboa, "36 coisas que precisa de saber sobre o Trumps": the club nearly opened as Frogs; the name Trumps nods to the London club Tramp.\nRound 4, question 2: Wikipedia PT "António Variações"; Renascença (13 August 2019): in 1979 he opened his own barbershop, É Pró Menino e Prá Menina, on Rua de São José.\nRound 4, question 3: Observador, "Como a existência dramática de António Botto acabou numa avenida de Copacabana": in 1942 he was dismissed from the civil service for lacking "idoneidade moral".\nRound 4, question 4: Wikipedia "Francisco Correa Netto"; Mott and Assunção, "Love\'s Labors Lost", Journal of Homosexuality 16 (1989): five of his 1664 love letters to the musician Manuel Viegas survive in the Inquisition archive.',
      quiz: {
        title: 'Lisboa queer e ícones portugueses',
        languages: 'both',
        screenLanguage: 'pt',
        rounds: [
          {
            kind: 'quiz',
            title: {
              en: 'Hidden Lisbon',
              pt: 'Lisboa escondida',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'The Lisbon Inquisition, which put people on trial for sodomy, had its seat where the Teatro Nacional D. Maria II now stands, what was that palace called?',
                  pt: 'A Inquisição de Lisboa, que julgava pessoas por sodomia, tinha a sede onde hoje está o Teatro Nacional D. Maria II, como se chamava esse palácio?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Palácio da Ribeira',
                      pt: 'Palácio da Ribeira',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Palácio dos Estaus',
                      pt: 'Palácio dos Estaus',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Palácio de Belém',
                      pt: 'Palácio de Belém',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Palácio da Ajuda',
                      pt: 'Palácio da Ajuda',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'On 13 May 1974, less than three weeks after the Carnation Revolution, the manifesto Liberdade para as minorias sexuais appeared in which Lisbon newspaper?',
                  pt: 'A 13 de maio de 1974, menos de três semanas depois do 25 de Abril, o manifesto Liberdade para as minorias sexuais saiu em que jornal de Lisboa?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Expresso',
                      pt: 'Expresso',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'O Século',
                      pt: 'O Século',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Diário de Notícias',
                      pt: 'Diário de Notícias',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Diário de Lisboa',
                      pt: 'Diário de Lisboa',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which Príncipe Real club, open since 1976, is home to the oldest drag shows in Lisbon?',
                  pt: 'Que clube do Príncipe Real, aberto desde 1976, tem os espetáculos de drag mais antigos de Lisboa?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Trumps',
                      pt: 'Trumps',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Hot Clube',
                      pt: 'Hot Clube',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Finalmente',
                      pt: 'Finalmente',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Lux Frágil',
                      pt: 'Lux Frágil',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "In 1923 Lisbon's civil governor had three books seized and burned as immoral, who wrote Decadência, one of the three?",
                  pt: 'Em 1923, o governador civil de Lisboa mandou apreender e queimar três livros por imoralidade, quem escreveu Decadência, um dos três?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Judith Teixeira',
                      pt: 'Judith Teixeira',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Florbela Espanca',
                      pt: 'Florbela Espanca',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Natália Correia',
                      pt: 'Natália Correia',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Sophia de Mello Breyner',
                      pt: 'Sophia de Mello Breyner',
                    },
                  },
                ],
                answer: {
                  correctIndex: 0,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Fernando Pessoa led the 1923 student campaign against what it called the literature of Sodom',
                  pt: 'Fernando Pessoa liderou a campanha de estudantes de 1923 contra a chamada literatura de Sodoma',
                },
                options: [],
                answer: {
                  isTrue: false,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'In 2025 a new Lisbon stage was named after Valentim de Barros, a dancer held for decades in a psychiatric hospital because he was gay',
                  pt: 'Em 2025, um novo palco de Lisboa recebeu o nome de Valentim de Barros, um bailarino internado durante décadas num hospital psiquiátrico por ser gay',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Icons',
              pt: 'Ícones',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Fernando Santos, the drag artist Deborah Kristall at Finalmente, played the lead in which João Pedro Rodrigues film, shown at Cannes in 2009?',
                  pt: 'Fernando Santos, a artista drag Deborah Kristall do Finalmente, foi protagonista de que filme de João Pedro Rodrigues, exibido em Cannes em 2009?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'O Fantasma',
                      pt: 'O Fantasma',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Morrer como um Homem',
                      pt: 'Morrer como um Homem',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Tabu',
                      pt: 'Tabu',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Variações',
                      pt: 'Variações',
                    },
                  },
                ],
                answer: {
                  correctIndex: 1,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which poet wrote the lyrics of Desfolhada and Tourada, two Portuguese Eurovision entries?',
                  pt: 'Que poeta escreveu as letras de Desfolhada e Tourada, duas canções portuguesas na Eurovisão?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'José Saramago',
                      pt: 'José Saramago',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Mário Cesariny',
                      pt: 'Mário Cesariny',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Ary dos Santos',
                      pt: 'Ary dos Santos',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'António Botto',
                      pt: 'António Botto',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "Mário Cesariny's most famous poem, You are welcome to Elsinore, comes from which 1957 book?",
                  pt: 'O poema mais famoso de Mário Cesariny, You are welcome to Elsinore, é de que livro de 1957?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Mensagem',
                      pt: 'Mensagem',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'O Medo',
                      pt: 'O Medo',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Canções',
                      pt: 'Canções',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Pena Capital',
                      pt: 'Pena Capital',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'President Cavaco Silva signed the same-sex marriage law on 17 May 2010, the International Day Against Homophobia',
                  pt: 'O Presidente Cavaco Silva promulgou a lei do casamento entre pessoas do mesmo sexo a 17 de maio de 2010, Dia Internacional contra a Homofobia',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'The first openly gay member of the Portuguese parliament, elected in 2009, was the anthropologist Miguel Vale de Almeida',
                  pt: 'O primeiro deputado assumidamente gay da Assembleia da República, eleito em 2009, foi o antropólogo Miguel Vale de Almeida',
                },
                options: [],
                answer: {
                  isTrue: true,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Fernando Pessoa defended the banned writers of 1923 in the pamphlet Aviso por causa da moral, which of his heteronyms signed it?',
                  pt: 'Fernando Pessoa defendeu os escritores proibidos de 1923 no panfleto Aviso por causa da moral, que heterónimo o assinou?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Álvaro de Campos',
                    pt: 'Álvaro de Campos',
                  },
                },
                acceptedAnswers: ['Campos', 'Alvaro Campos'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Lila Fadista and João Caçador started which queer fado project in Lisbon in 2017?',
                  pt: 'Lila Fadista e João Caçador criaram que projeto de fado queer em Lisboa, em 2017?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Fado Bicha',
                    pt: 'Fado Bicha',
                  },
                },
                acceptedAnswers: ['Bicha'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Dates and numbers',
              pt: 'Datas e números',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'António Variações died on 13 June 1984, the day Lisbon celebrates which saint?',
                  pt: 'António Variações morreu a 13 de junho de 1984, o dia em que Lisboa celebra que santo?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Saint Anthony',
                    pt: 'Santo António',
                  },
                },
                acceptedAnswers: ['Santo Antonio', 'St Anthony', 'Antonio'],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these moments of queer Lisbon in order, earliest first',
                  pt: 'Põe estes momentos da Lisboa queer por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Finalmente opens in Príncipe Real',
                      pt: 'O Finalmente abre no Príncipe Real',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Trumps opens on Rua da Imprensa Nacional',
                      pt: 'O Trumps abre na Rua da Imprensa Nacional',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'ILGA Portugal is founded',
                      pt: 'É fundada a ILGA Portugal',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Lisbon hosts EuroPride for the first time',
                      pt: 'Lisboa recebe o EuroPride pela primeira vez',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these changes in Portuguese law in order, earliest first',
                  pt: 'Põe estas mudanças na lei portuguesa por ordem, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'One age of consent for every sexual orientation',
                      pt: 'A mesma idade de consentimento para todas as orientações',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Changing legal sex and name at the civil registry',
                      pt: 'Mudança de sexo e de nome no registo civil',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Assisted reproduction open to all women',
                      pt: 'Procriação medicamente assistida para todas as mulheres',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Conversion practices banned',
                      pt: 'Proibição das práticas de conversão',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these moments in Portuguese queer history in order, earliest first',
                  pt: 'Põe estes momentos da história queer portuguesa por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'O Barão de Lavos, a novel with a gay lead, comes out',
                      pt: 'Sai O Barão de Lavos, romance com um protagonista gay',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: "Botto's Canções is seized in Lisbon",
                      pt: 'As Canções de Botto são apreendidas em Lisboa',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'A manifesto for sexual minorities appears in the press',
                      pt: 'Um manifesto pelas minorias sexuais sai nos jornais',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Teresa Pires and Helena Paixão marry in Lisbon',
                      pt: 'Teresa Pires e Helena Paixão casam em Lisboa',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['a', 'b', 'c', 'd'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "How many copies of Raul Leal's pamphlet Sodoma Divinizada did Pessoa's press print in 1923?",
                  pt: 'Quantos exemplares do panfleto Sodoma Divinizada, de Raul Leal, imprimiu a editora de Pessoa em 1923?',
                },
                options: [],
                answer: {
                  value: 350,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "The giant cypress in the garden of Príncipe Real, Lisbon's historic gay neighbourhood, grows flat over an iron frame, about how many metres across is its canopy?",
                  pt: 'O cedro-do-buçaco gigante do jardim do Príncipe Real, o bairro gay histórico de Lisboa, cresce deitado sobre uma estrutura de ferro, quantos metros tem a copa de diâmetro, mais ou menos?',
                },
                options: [],
                answer: {
                  value: 22,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Lie Detector',
              pt: 'Detetor de mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Before it opened in 1980, the Lisbon club Trumps nearly had a different name, what was it?',
                  pt: 'Antes de abrir em 1980, o Trumps esteve quase para ter outro nome, qual era?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Frogs',
                    pt: 'Frogs',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'What did António Variações call the barbershop he opened in Lisbon in 1979?',
                  pt: 'Que nome deu António Variações à barbearia que abriu em Lisboa em 1979?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'É Pró Menino e Prá Menina',
                    pt: 'É Pró Menino e Prá Menina',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'In 1942 the poet António Botto lost his civil service job, what reason did the state give?',
                  pt: 'Em 1942, o poeta António Botto foi afastado da função pública, que motivo deu o Estado?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Lack of moral fitness',
                    pt: 'Falta de idoneidade moral',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'prompt',
                prompt: {
                  en: 'In 1664 Francisco Correa Netto, a sacristan in Silves, wrote love letters to the musician Manuel Viegas, where did they survive for centuries?',
                  pt: 'Em 1664, Francisco Correa Netto, sacristão em Silves, escreveu cartas de amor ao músico Manuel Viegas, onde sobreviveram durante séculos?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'In the Inquisition archive',
                    pt: 'No arquivo da Inquisição',
                  },
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
            ],
          },
        ],
      },
    },
  ];
