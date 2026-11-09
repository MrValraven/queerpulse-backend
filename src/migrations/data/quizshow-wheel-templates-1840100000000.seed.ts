/**
 * A frozen copy of the five wheel templates written on 2026-11-09 (Pop divas,
 * Queer anthems, Queer TV night, Screen icons, Sapphic night). It seeds
 * AddQuizshowWheelTemplates1840100000000. Do not edit: staff edit the
 * templates in the admin dashboard once the migration has run. The frontend
 * demo copy lives in queerpulse/src/features/quizshow/demo/wheelPacks/.
 */
export interface QuizshowWheelTemplateSeed {
  id: string;
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
      settings: Record<string, number | boolean | string | null>;
      questions: Array<Record<string, unknown>>;
    }>;
  };
}

export const QUIZSHOW_WHEEL_TEMPLATE_SEEDS_1840100000000: readonly QuizshowWheelTemplateSeed[] =
  [
    {
      id: 'a7e3b1c0-5eed-4000-8000-000000000007',
      cardTitle: {
        en: 'Pop divas: spin the wheel',
        pt: 'Divas pop: gira a roda',
      },
      cardDescription: {
        en: 'Number ones, chart records, album eras, a diva Lie Detector and pop alter egos, and the wheel decides which round plays next',
        pt: 'Números um, recordes nas tabelas, eras de álbuns, um Detetor de Mentiras de divas e alter egos pop, e é a roda que decide a ronda seguinte',
      },
      staffNotes:
        "Round 1, question 1: Wikipedia, List of Billboard Hot 100 number ones of 1984, and Stereogum The Number Ones: Like a Virgin hit No. 1 on 22 December 1984, Madonna's first Hot 100 number one (Material Girl peaked No. 2, Lucky Star No. 4)\nRound 1, question 2: Wikipedia, Whitney Houston singles discography and Where Do Broken Hearts Go: the song topped the Hot 100 on 23 April 1988, her seventh consecutive No. 1, beating the six of The Beatles and Bee Gees\nRound 1, question 3: Guinness World Records (oldest female artist to reach No. 1 on the US Hot 100) and Billboard: Cher was 52 when Believe topped the Hot 100 in March 1999, the oldest woman to do so at that time (Brenda Lee's holiday song passed it in 2023, hence 'at the time')\nRound 1, question 4: Billboard via The Fader (16 December 2019) and AP: All I Want for Christmas Is You first reached No. 1 on the Hot 100 chart dated 21 December 2019, 25 years after release\nRound 1, question 5: Wikipedia, The Loco-Motion and Kylie (album), plus NFSA Kyliemania: Kylie's debut single was her 1987 cover Locomotion, seven weeks at No. 1 on the Australian Kent Music Report\nRound 1, question 6: Wikipedia, Rihanna singles discography and Pon de Replay: Pon de Replay peaked at No. 2 on the Hot 100 (behind We Belong Together); SOS (2006) was her first No. 1. Answer false\nRound 2, question 1: Guinness World Records (most US No. 1 singles by a solo artist) and Billboard: Mariah Carey has 19 Hot 100 number ones, the 19th being All I Want for Christmas Is You on 21 December 2019; none added in 2020 to 2024\nRound 2, question 2: whitneyhouston.com, American Songwriter and Wikipedia, List of Billboard Hot 100 number ones of 1992: I Will Always Love You reached No. 1 on 28 November 1992 and stayed 14 weeks\nRound 2, question 3: Wikipedia, I Feel Love, and 909originals: released in 1977 (B-side in May, A-side in July 1977), produced by Giorgio Moroder and Pete Bellotte, from I Remember Yesterday\nRound 2, question 4: CBS News, ABC7 and The Week (5 February 2023): Beyoncé reached 32 career Grammys at the 2023 ceremony, passing Georg Solti's 31\nRound 2, question 5: Wikipedia, List of Billboard Hot 100 number ones of 1999: ...Baby One More Time was No. 1 on the chart dated 30 January 1999; Britney was born 2 December 1981, so she was 17\nRound 2, question 6: Wikipedia, What's Love Got to Do with It (song), and Stereogum The Number Ones: it was Tina Turner's first and only solo Hot 100 No. 1 (1984); Proud Mary with Ike peaked at No. 4. Answer true\nRound 3, question 1: Wikipedia, Madonna albums discography: Like a Virgin 1984, Like a Prayer 1989, Ray of Light 1998, Confessions on a Dance Floor 2005\nRound 3, question 2: Wikipedia, Britney Spears discography: Oops!... I Did It Again (May 2000), In the Zone (2003), Blackout (2007), Circus (2008)\nRound 3, question 3: Wikipedia, Lady Gaga discography: The Fame 2008, Born This Way 2011, Artpop 2013, Chromatica 2020\nRound 3, question 4: Wikipedia album pages: Whitney Houston (14 February 1985), Mariah Carey (12 June 1990), ...Baby One More Time (12 January 1999), Music of the Sun (30 August 2005)\nRound 3, question 5: Official Charts and Rolling Stone: Radical Optimism, Dua Lipa's third studio album, released 3 May 2024 (Future Nostalgia was the second, Club Future Nostalgia a remix album)\nRound 3, question 6: Wikipedia, Charli XCX discography: True Romance (April 2013), Sucker (December 2014), Charli (2019), Brat (June 2024)\nRound 4, question 1: Grammy.com (Madonna wins Best Pop Album for Ray of Light, 1999 Grammy Rewind) and Wikipedia, Ray of Light: produced with William Orbit, won Best Pop Album at the 41st Grammys\nRound 4, question 2: Grammy.com, Album of the Year 1994, and Deseret News (2 March 1994): The Bodyguard Original Soundtrack Album won Album of the Year at the 36th Grammys. Accepted answers include the Portuguese film title O Guarda-Costas\nRound 4, question 3: Reuters via 1News (14 November 2020) and Wikipedia, Disco (Kylie Minogue album): Disco was largely recorded in her home studio during the COVID-19 lockdown, released 6 November 2020\nRound 4, question 4: Wikipedia, I Am... Sasha Fierce: Beyoncé's third studio album (November 2008), built around her alter ego Sasha Fierce\nRound 4, question 5: Wikipedia, Control (Janet Jackson album), and Treble: third album, released 4 February 1986, produced with Jimmy Jam and Terry Lewis, her first Billboard 200 No. 1\nRound 4, question 6: Wikipedia, The Emancipation of Mimi, Tampa Bay Times (30 November 2004) and BMI: 2005 album; Carey called Mimi a very personal nickname only used by those closest to her\nRound 5, question 1: CNN Style (Remember when Kylie Minogue's gold hotpants...), Euronews (22 November 2021) and Broadsheet: the gold lame hotpants from Spinning Around cost 50p, bought secondhand in London by photographer Katerina Jebb (the exact shop or market varies by source: North End Road, Camden, an Oxfam shop per NFSA, so the prompt only says a secondhand find in London)\nRound 5, question 2: MTV News (Chasing Banana) and Yahoo/AP interview with snake handler Mike Hano: Britney posted about the python years later and christened it Banana (Yahoo cites a tweet 11 years on, Bustle an Instagram post; Hano says it had no such name at the time, so the prompt says 'on social media')\nRound 5, question 3: Wikipedia, Tina Turner, and Tennessee Encyclopedia: born Anna Mae Bullock on 26 November 1939\nRound 5, question 4: PinkNews (13 February 2011), The Daily Beast and Grammy.com: Lady Gaga arrived at the 2011 Grammys inside a giant egg carried by models and hatched from it to perform Born This Way\nRound 6, question 1: party prompt, no fact to check\nRound 6, question 2: party prompt, no fact to check\nRound 6, question 3: party prompt, no fact to check",
      quiz: {
        title: 'Pop divas: spin the wheel',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'wheel',
            title: {
              en: '',
              pt: '',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Number ones',
              pt: 'Números um',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which song gave Madonna her first number one on the US Billboard Hot 100?',
                  pt: 'Que canção deu à Madonna o primeiro número um na Billboard Hot 100 dos EUA?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Holiday',
                      pt: 'Holiday',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Lucky Star',
                      pt: 'Lucky Star',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Like a Virgin',
                      pt: 'Like a Virgin',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Material Girl',
                      pt: 'Material Girl',
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
                  en: 'In 1988, which diva became the first artist with seven consecutive number ones on the US Hot 100?',
                  pt: 'Em 1988, que diva se tornou a primeira artista com sete números um seguidos na Hot 100 dos EUA?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Madonna',
                      pt: 'Madonna',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Whitney Houston',
                      pt: 'Whitney Houston',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Mariah Carey',
                      pt: 'Mariah Carey',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Janet Jackson',
                      pt: 'Janet Jackson',
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
                  en: 'Which song made Cher, at 52, the oldest woman at the time to top the US Hot 100 in 1999?',
                  pt: 'Que canção fez da Cher, aos 52 anos, a mulher mais velha até então a chegar ao topo da Hot 100 dos EUA, em 1999?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Believe',
                      pt: 'Believe',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Strong Enough',
                      pt: 'Strong Enough',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'If I Could Turn Back Time',
                      pt: 'If I Could Turn Back Time',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The Shoop Shoop Song',
                      pt: 'The Shoop Shoop Song',
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
                  en: "In what year did Mariah Carey's All I Want for Christmas Is You first reach number one on the US Hot 100?",
                  pt: 'Em que ano é que All I Want for Christmas Is You, da Mariah Carey, chegou pela primeira vez ao número um da Hot 100 dos EUA?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: '1994',
                      pt: '1994',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: '2000',
                      pt: '2000',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: '2012',
                      pt: '2012',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: '2019',
                      pt: '2019',
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
                  en: "Kylie Minogue's debut single topped the Australian chart in 1987. It was a cover of which song?",
                  pt: 'O single de estreia da Kylie Minogue chegou ao número um na Austrália em 1987. Era uma versão de que canção?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Respect',
                      pt: 'Respect',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'I Should Be So Lucky',
                      pt: 'I Should Be So Lucky',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Loco-Motion',
                      pt: 'The Loco-Motion',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Venus',
                      pt: 'Venus',
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
                type: 'true_false',
                prompt: {
                  en: "Rihanna's debut single Pon de Replay reached number one on the US Hot 100",
                  pt: 'O single de estreia da Rihanna, Pon de Replay, chegou ao número um da Hot 100 dos EUA',
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
              en: 'Charts in numbers',
              pt: 'Tabelas em números',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 1000,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'closest_number',
                prompt: {
                  en: 'By the end of 2024, how many US Hot 100 number ones had Mariah Carey scored?',
                  pt: 'Até ao fim de 2024, quantos números um na Hot 100 dos EUA tinha somado a Mariah Carey?',
                },
                options: [],
                answer: {
                  value: 19,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "How many weeks did Whitney Houston's I Will Always Love You spend at number one on the US Hot 100 in 1992 and 1993?",
                  pt: 'Quantas semanas passou I Will Always Love You, da Whitney Houston, no número um da Hot 100 dos EUA entre 1992 e 1993?',
                },
                options: [],
                answer: {
                  value: 14,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In what year did Donna Summer release I Feel Love, the synth disco track made with Giorgio Moroder?',
                  pt: 'Em que ano lançou a Donna Summer I Feel Love, o tema disco de sintetizadores feito com Giorgio Moroder?',
                },
                options: [],
                answer: {
                  value: 1977,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How many Grammys had Beyoncé won in total after the February 2023 ceremony, the night she broke the all-time record?',
                  pt: 'Quantos Grammys tinha a Beyoncé ganho no total depois da cerimónia de fevereiro de 2023, a noite em que bateu o recorde absoluto?',
                },
                options: [],
                answer: {
                  value: 32,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How old was Britney Spears when ...Baby One More Time hit number one on the US Hot 100 in January 1999?',
                  pt: 'Que idade tinha a Britney Spears quando ...Baby One More Time chegou ao número um da Hot 100 dos EUA, em janeiro de 1999?',
                },
                options: [],
                answer: {
                  value: 17,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "What's Love Got to Do with It is Tina Turner's only solo number one on the US Hot 100",
                  pt: "What's Love Got to Do with It é o único número um a solo da Tina Turner na Hot 100 dos EUA",
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
              en: 'Release order',
              pt: 'Ordem de lançamento',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'order',
                prompt: {
                  en: 'Put these Madonna albums in order, earliest first',
                  pt: 'Põe estes álbuns da Madonna por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Ray of Light',
                      pt: 'Ray of Light',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Like a Virgin',
                      pt: 'Like a Virgin',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Confessions on a Dance Floor',
                      pt: 'Confessions on a Dance Floor',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Like a Prayer',
                      pt: 'Like a Prayer',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'a', 'c'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which of these Britney Spears albums came out first?',
                  pt: 'Qual destes álbuns da Britney Spears saiu primeiro?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Blackout',
                      pt: 'Blackout',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Circus',
                      pt: 'Circus',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Oops!... I Did It Again',
                      pt: 'Oops!... I Did It Again',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'In the Zone',
                      pt: 'In the Zone',
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
                type: 'order',
                prompt: {
                  en: 'Put these Lady Gaga albums in order, earliest first',
                  pt: 'Põe estes álbuns da Lady Gaga por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Chromatica',
                      pt: 'Chromatica',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Fame',
                      pt: 'The Fame',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Artpop',
                      pt: 'Artpop',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Born This Way',
                      pt: 'Born This Way',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'c', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these debut albums in order, earliest first',
                  pt: 'Põe estes álbuns de estreia por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Britney Spears: ...Baby One More Time',
                      pt: 'Britney Spears: ...Baby One More Time',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Rihanna: Music of the Sun',
                      pt: 'Rihanna: Music of the Sun',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Whitney Houston: Whitney Houston',
                      pt: 'Whitney Houston: Whitney Houston',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Mariah Carey: Mariah Carey',
                      pt: 'Mariah Carey: Mariah Carey',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'd', 'a', 'b'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "What is the title of Dua Lipa's third studio album, released in May 2024?",
                  pt: 'Como se chama o terceiro álbum de estúdio da Dua Lipa, lançado em maio de 2024?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Future Nostalgia',
                      pt: 'Future Nostalgia',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Radical Optimism',
                      pt: 'Radical Optimism',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Club Future Nostalgia',
                      pt: 'Club Future Nostalgia',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Dua Lipa',
                      pt: 'Dua Lipa',
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
                type: 'order',
                prompt: {
                  en: 'Put these Charli XCX albums in order, earliest first',
                  pt: 'Põe estes álbuns da Charli XCX por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Brat',
                      pt: 'Brat',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Sucker',
                      pt: 'Sucker',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'True Romance',
                      pt: 'True Romance',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Charli',
                      pt: 'Charli',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'b', 'd', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Name the album',
              pt: 'Diz o álbum',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'Which 1998 Madonna album, made with producer William Orbit, won the Grammy for Best Pop Album?',
                  pt: 'Que álbum da Madonna de 1998, feito com o produtor William Orbit, ganhou o Grammy de Melhor Álbum Pop?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Ray of Light',
                    pt: 'Ray of Light',
                  },
                },
                acceptedAnswers: [
                  'Ray of Light',
                  'Ray Of Light',
                  'Ray of Lite',
                  'Rays of Light',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Which 1992 soundtrack won Whitney Houston the Grammy for Album of the Year?',
                  pt: 'Que banda sonora de 1992 deu à Whitney Houston o Grammy de Álbum do Ano?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'The Bodyguard',
                    pt: 'The Bodyguard',
                  },
                },
                acceptedAnswers: [
                  'The Bodyguard',
                  'Bodyguard',
                  'The Body Guard',
                  'Body Guard',
                  'O Guarda-Costas',
                  'Guarda-Costas',
                  'Guarda Costas',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Kylie Minogue recorded most of her 2020 album in her home studio during lockdown. What is its one-word title?',
                  pt: 'A Kylie Minogue gravou quase todo o álbum de 2020 no estúdio de casa, durante o confinamento. Qual é o título, numa só palavra?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Disco',
                    pt: 'Disco',
                  },
                },
                acceptedAnswers: ['Disco', 'Disko'],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "Beyoncé's 2008 album is named after her on-stage alter ego. What is it called?",
                  pt: 'O álbum de 2008 da Beyoncé tem o nome do alter ego dela em palco. Como se chama?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: "B'Day",
                      pt: "B'Day",
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: '4',
                      pt: '4',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'I Am... Sasha Fierce',
                      pt: 'I Am... Sasha Fierce',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Dangerously in Love',
                      pt: 'Dangerously in Love',
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
                type: 'type_answer',
                prompt: {
                  en: "Janet Jackson's 1986 breakthrough album, made with Jimmy Jam and Terry Lewis, was her first Billboard 200 number one. What is its one-word title?",
                  pt: 'O álbum de 1986 que consagrou a Janet Jackson, feito com Jimmy Jam e Terry Lewis, foi o primeiro número um dela na Billboard 200. Qual é o título, numa só palavra?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Control',
                    pt: 'Control',
                  },
                },
                acceptedAnswers: ['Control', 'Controle', 'Kontrol'],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 2000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: "Mariah Carey's 2005 comeback album has a nickname in its title that only her closest people use. What is the album called?",
                  pt: 'O álbum de regresso da Mariah Carey, de 2005, tem no título uma alcunha que só os mais próximos usam. Como se chama o álbum?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'The Emancipation of Mimi',
                    pt: 'The Emancipation of Mimi',
                  },
                },
                acceptedAnswers: [
                  'The Emancipation of Mimi',
                  'Emancipation of Mimi',
                  'The Emancipation of Mimmi',
                  'Emancipation of Mimmi',
                  'The Emancipation',
                  'Emancipation',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Diva Lie Detector',
              pt: 'Detetor de Mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: "Kylie's gold hotpants from the Spinning Around video were a secondhand find in London. What did they reportedly cost?",
                  pt: 'Os calções dourados da Kylie no vídeo de Spinning Around foram comprados em segunda mão em Londres. Quanto terão custado?',
                },
                options: [],
                answer: {
                  truth: {
                    en: '50p',
                    pt: '50 pence',
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
                  en: 'Years after dancing with a python at the 2001 VMAs, what name did Britney give the snake on social media?',
                  pt: 'Anos depois de dançar com uma cobra gigante nos VMAs de 2001, que nome lhe deu a Britney nas redes sociais?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Banana',
                    pt: 'Banana',
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
                  en: "What was Tina Turner's birth name?",
                  pt: 'Qual era o nome de nascimento da Tina Turner?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Anna Mae Bullock',
                    pt: 'Anna Mae Bullock',
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
                  en: 'What did Lady Gaga arrive inside on the 2011 Grammys red carpet?',
                  pt: 'Dentro de quê chegou a Lady Gaga à passadeira vermelha dos Grammys de 2011?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'A giant egg',
                    pt: 'Um ovo gigante',
                  },
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
              en: 'Pop alter ego',
              pt: 'Alter ego pop',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Your diva alter ego is your favourite dessert plus the city of your best night out, what is her name?',
                  pt: 'O teu alter ego de diva é a tua sobremesa favorita mais a cidade da tua melhor noite de sempre, como se chama?',
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
                  en: "You've just landed a Las Vegas residency. Name the show using your morning drink and your most dramatic habit",
                  pt: 'Acabaste de conseguir uma residência em Las Vegas. Dá nome ao espetáculo com a tua bebida da manhã e o teu hábito mais dramático',
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
                  en: 'Your comeback album drops at midnight and its title mixes a gemstone with the last emoji you sent, what is it called?',
                  pt: 'O teu álbum de regresso sai à meia-noite e o título junta uma pedra preciosa com o último emoji que enviaste, como se chama?',
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
      id: 'a7e3b1c0-5eed-4000-8000-000000000008',
      cardTitle: {
        en: 'Queer anthems: spin the wheel',
        pt: 'Hinos queer: gira a roda',
      },
      cardDescription: {
        en: 'Dancefloor anthems, music videos, collabs, the stories behind the songs and out and proud artists, plus a Lie Detector, and a spinning wheel picks what plays next',
        pt: 'Hinos de pista, telediscos, colaborações, as histórias por trás das canções e artistas assumidos, mais um Detetor de Mentiras, e uma roda decide o que se joga a seguir',
      },
      staffNotes:
        "Round 1, question 1: Wikipedia 'Don't Leave Me This Way' (en.wikipedia.org/wiki/Don%27t_Leave_Me_This_Way) and Songfacts: written by Gamble, Huff and Gilbert, first recorded by Harold Melvin & the Blue Notes (Teddy Pendergrass lead) in 1975; Thelma Houston covered it in 1976, The Communards in 1986\nRound 1, question 2: Wikipedia 'Smalltown Boy' (en.wikipedia.org/wiki/Smalltown_Boy): debut single by Bronski Beat, released in 1984 (May/June 1984), from The Age of Consent\nRound 1, question 3: Wikipedia 'Y.M.C.A. (song)': released October 1978; Wikipedia 'Relax (song)': released 24 October 1983; Wikipedia 'Freedom! '90': released 1990 from Listen Without Prejudice Vol. 1; Wikipedia 'Dancing on My Own': Robyn, released 20 April 2010\nRound 1, question 4: Wikipedia 'It's Raining Men' and CBC / Canadian Songwriters Hall of Fame (cshf.ca/song/its-raining-men): released by The Weather Girls (Martha Wash and Izora Armstead, formerly Two Tons o' Fun) on 10 September 1982 under the Weather Girls name, so only that name is accepted\nRound 1, question 5: Wikipedia 'True Colors (Cyndi Lauper song)' and Songfacts: written by Billy Steinberg and Tom Kelly, first released by Cyndi Lauper as the title track and lead single of her 1986 album; Phil Collins covered it in 1998\nRound 2, question 1: Wikipedia 'Vogue (Madonna song)' and HuffPost UK '35 things you didn't know about Vogue': video directed by David Fincher, shot in black and white\nRound 2, question 2: Wikipedia 'Freedom! '90' and Biography.com 'George Michael Freedom 90 music video': directed by David Fincher, George Michael does not appear; Naomi Campbell, Linda Evangelista, Christy Turlington, Cindy Crawford and Tatjana Patitz lip-sync instead\nRound 2, question 3: Wikipedia 'I Want to Break Free' and Louder 'Video breakdown: Queen, I Want To Break Free': video directed by David Mallet, the band in drag parodying the ITV soap Coronation Street\nRound 2, question 4: Wikipedia 'I'm Still Standing', eltonjohn.com 'I'm Still Standing 4K' and Rolling Stone (restored video article): directed by Russell Mulcahy, shot in Cannes and Nice on the French Riviera in June 1983\nRound 2, question 5: Wikipedia 'Outside (George Michael song)' and The Advocate 'George Michael Outside music video': directed by Vaughan Arnell, mocks his April 1998 arrest in a Beverly Hills public toilet; he dances as a police officer in a toilet styled as a disco\nRound 3, question 1: Wikipedia 'Barcelona (Freddie Mercury and Montserrat Caballe song)' and Olympics.com 'When rock met opera: the story behind Barcelona': duet of Freddie Mercury and soprano Montserrat Caballe, released 1987\nRound 3, question 2: Wikipedia 'What Have I Done to Deserve This? (song)' and petshopboys.co.uk: Pet Shop Boys with Dusty Springfield, single released 10 August 1987\nRound 3, question 3: CBS News and Rolling Stone (Feb 2023): Sam Smith and Kim Petras won Best Pop Duo/Group Performance for 'Unholy' at the 65th Grammys, 5 February 2023\nRound 3, question 4: Wikipedia 'Slide (Calvin Harris song)' and Official Charts announcement: 'Slide' (23 February 2017) features Frank Ocean and Migos; Rihanna is not on it, so the statement is false\nRound 3, question 5: Wikipedia 'Don't Go Breaking My Heart' (Elton John and Kiki Dee, 1976); Wikipedia 'Under Pressure' and bowiebible.com (Queen and David Bowie, October 1981); Wikipedia 'Don't Let the Sun Go Down on Me' and eltonjohn.com (George Michael and Elton John live duet recorded 23 March 1991, released November 1991); Wikipedia 'Cold Heart (Pnau remix)' and eltonjohn.com (Elton John and Dua Lipa, 13 August 2021)\nRound 4, question 1: Wikipedia 'Tainted Love' and uDiscover Music: written by Ed Cobb, first recorded by Gloria Jones in 1964 (released 1965); Soft Cell's cover came in 1981\nRound 4, question 2: Wikipedia 'Paul Jabara', Songfacts 'It's Raining Men' and American Songwriter: written by Paul Jabara and Paul Shaffer (bandleader on David Letterman's shows) in 1979\nRound 4, question 3: Wikipedia 'Vogue (Madonna song)' and HuffPost UK: 'Vogue' was made as the B-side for 'Keep It Together' and was judged too good, so it became a single\nRound 4, question 4: Wikipedia 'I Will Survive' and Stereogum 'The Number Ones: Gloria Gaynor's I Will Survive': first released as the B-side of her cover of 'Substitute'; DJs flipped it\nRound 4, question 5: Wikipedia 'I'm Coming Out', PBS NewsHour 'The accidental history of Pride anthems' and PinkNews (22 May 2020): Nile Rodgers wrote it with Bernard Edwards after seeing drag queens dressed as Diana Ross at a New York club\nRound 5, question 1: Wikipedia 'Channel Orange', MTV News and The Fader: Frank Ocean posted an open letter on his Tumblr on 4 July 2012 about his first love, a man\nRound 5, question 2: Attitude archive 'Neil Tennant's 1994 coming out interview' (attitude.co.uk) and Wikipedia 'Neil Tennant': came out as gay in Attitude's August 1994 issue, interview by Paul Burston\nRound 5, question 3: Hello! magazine and Ultimate Classic Rock 'Elton John and David Furnish': civil partnership at Windsor Guildhall on 21 December 2005, married on 21 December 2014\nRound 5, question 4: Rolling Stone 'Lil Nas X comes out on World Pride Day' and Out.com (30 June 2019): he came out in tweets on 30 June 2019, the last day of Pride Month\nRound 5, question 5: Wikipedia 'Sylvester (singer)' and Wikipedia 'You Make Me Feel (Mighty Real)': born in Watts, Los Angeles, openly gay, known as the Queen of Disco; the song was a 1978 single from Step II\nRound 6, question 1: NBC News and Rolling Stone (March 2021): MSCHF's 666 pairs of 'Satan Shoes' (modified Nike Air Max 97s) had ink mixed with a drop of human blood in the sole's air bubble\nRound 6, question 2: abbasite.com 'In Focus: Dancing Queen' and Songfacts: the working title of 'Dancing Queen' was 'Boogaloo'\nRound 6, question 3: Wikipedia 'I Will Survive' and Stereogum 'The Number Ones': Gaynor recorded the vocal in a back brace about a month after spinal surgery",
      quiz: {
        title: 'Queer anthems: spin the wheel',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'wheel',
            title: {
              en: '',
              pt: '',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'question',
              sliceCount: null,
            },
            questions: [],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Anthems',
              pt: 'Hinos',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who recorded the very first version of "Don\'t Leave Me This Way", back in 1975?',
                  pt: 'Quem gravou a primeiríssima versão de "Don\'t Leave Me This Way", em 1975?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Thelma Houston',
                      pt: 'Thelma Houston',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Communards',
                      pt: 'The Communards',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Harold Melvin & the Blue Notes',
                      pt: 'Harold Melvin & the Blue Notes',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Gloria Gaynor',
                      pt: 'Gloria Gaynor',
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
                type: 'closest_number',
                prompt: {
                  en: 'In which year did Bronski Beat release "Smalltown Boy"?',
                  pt: 'Em que ano é que os Bronski Beat lançaram "Smalltown Boy"?',
                },
                options: [],
                answer: {
                  value: 1984,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these dancefloor anthems in release order, earliest first',
                  pt: 'Põe estes hinos de pista por ordem de lançamento, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Robyn, "Dancing On My Own"',
                      pt: 'Robyn, "Dancing On My Own"',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Village People, "Y.M.C.A."',
                      pt: 'Village People, "Y.M.C.A."',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'George Michael, "Freedom! \'90"',
                      pt: 'George Michael, "Freedom! \'90"',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Frankie Goes to Hollywood, "Relax"',
                      pt: 'Frankie Goes to Hollywood, "Relax"',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'c', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'type_answer',
                prompt: {
                  en: 'Which duo released "It\'s Raining Men" in 1982?',
                  pt: 'Que dupla lançou "It\'s Raining Men" em 1982?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'The Weather Girls',
                    pt: 'The Weather Girls',
                  },
                },
                acceptedAnswers: [
                  'Weather Girls',
                  'The Weather Girls',
                  'Weather Girl',
                  'Weathergirls',
                  'The Weathergirls',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who first recorded "True Colors", in 1986?',
                  pt: 'Quem gravou "True Colors" pela primeira vez, em 1986?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Cyndi Lauper',
                      pt: 'Cyndi Lauper',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Phil Collins',
                      pt: 'Phil Collins',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Bette Midler',
                      pt: 'Bette Midler',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Whitney Houston',
                      pt: 'Whitney Houston',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Music videos',
              pt: 'Telediscos',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 250,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who directed Madonna\'s black and white video for "Vogue"?',
                  pt: 'Quem realizou o teledisco a preto e branco de "Vogue", da Madonna?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Herb Ritts',
                      pt: 'Herb Ritts',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'David Fincher',
                      pt: 'David Fincher',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Spike Jonze',
                      pt: 'Spike Jonze',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Michel Gondry',
                      pt: 'Michel Gondry',
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
                type: 'true_false',
                prompt: {
                  en: 'George Michael never appears in the "Freedom! \'90" video, and supermodels lip-sync his vocals instead',
                  pt: 'O George Michael nunca aparece no teledisco de "Freedom! \'90", e são supermodelos que fazem playback da voz dele',
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
                  en: 'Queen dressed in drag for the "I Want to Break Free" video to parody which long-running British soap?',
                  pt: 'Os Queen vestiram-se de mulher no teledisco de "I Want to Break Free" para parodiar que novela britânica de longa duração?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Coronation Street',
                    pt: 'Coronation Street',
                  },
                },
                acceptedAnswers: [
                  'Coronation Street',
                  'Corrie',
                  'Coronation St',
                  'Coronation',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Where did Elton John shoot the sunny 1983 video for "I\'m Still Standing"?',
                  pt: 'Onde é que o Elton John filmou o teledisco solarengo de "I\'m Still Standing", em 1983?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Malibu, California',
                      pt: 'Malibu, Califórnia',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Ibiza, Spain',
                      pt: 'Ibiza, Espanha',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Amalfi Coast, Italy',
                      pt: 'Costa Amalfitana, Itália',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Cannes and Nice, France',
                      pt: 'Cannes e Nice, França',
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
                  en: 'George Michael\'s 1998 video for "Outside" pokes fun at his own arrest. Which place turns into a glittering disco?',
                  pt: 'O teledisco de "Outside" (1998), do George Michael, goza com a detenção dele. Que sítio se transforma numa discoteca cheia de brilho?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'A police station',
                      pt: 'Uma esquadra da polícia',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'A car park',
                      pt: 'Um parque de estacionamento',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'A public toilet',
                      pt: 'Uma casa de banho pública',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'A prison cell',
                      pt: 'Uma cela de prisão',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Collabs',
              pt: 'Colaborações',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Freddie Mercury recorded "Barcelona" in 1987 with which opera soprano?',
                  pt: 'O Freddie Mercury gravou "Barcelona" em 1987 com que soprano de ópera?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Maria Callas',
                      pt: 'Maria Callas',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Kiri Te Kanawa',
                      pt: 'Kiri Te Kanawa',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Victoria de los Ángeles',
                      pt: 'Victoria de los Ángeles',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Montserrat Caballé',
                      pt: 'Montserrat Caballé',
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
                  en: 'Which 1960s legend sang with Pet Shop Boys on "What Have I Done to Deserve This?"?',
                  pt: 'Que lenda dos anos 60 cantou com os Pet Shop Boys em "What Have I Done to Deserve This?"?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Petula Clark',
                      pt: 'Petula Clark',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Dusty Springfield',
                      pt: 'Dusty Springfield',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Lulu',
                      pt: 'Lulu',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Cilla Black',
                      pt: 'Cilla Black',
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
                type: 'type_answer',
                prompt: {
                  en: 'Who sings with Sam Smith on "Unholy", the duet that won them a Grammy in 2023?',
                  pt: 'Quem canta com Sam Smith em "Unholy", o dueto que lhes valeu um Grammy em 2023?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Kim Petras',
                    pt: 'Kim Petras',
                  },
                },
                acceptedAnswers: ['Kim Petras', 'Petras', 'Kim', 'Kim Petra'],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Calvin Harris\'s 2017 single "Slide" features Frank Ocean and Rihanna',
                  pt: 'O single "Slide", do Calvin Harris, de 2017, conta com o Frank Ocean e a Rihanna',
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
                type: 'order',
                prompt: {
                  en: 'Put these duets in release order, earliest first',
                  pt: 'Põe estes duetos por ordem de lançamento, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Elton John and Dua Lipa, "Cold Heart (Pnau Remix)"',
                      pt: 'Elton John e Dua Lipa, "Cold Heart (Pnau Remix)"',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Queen and David Bowie, "Under Pressure"',
                      pt: 'Queen e David Bowie, "Under Pressure"',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Elton John and Kiki Dee, "Don\'t Go Breaking My Heart"',
                      pt: 'Elton John e Kiki Dee, "Don\'t Go Breaking My Heart"',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'George Michael and Elton John, "Don\'t Let the Sun Go Down on Me"',
                      pt: 'George Michael e Elton John, "Don\'t Let the Sun Go Down on Me"',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'b', 'd', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Behind the song',
              pt: 'Por trás da canção',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Soft Cell\'s "Tainted Love" is a cover. Who recorded the original in 1964?',
                  pt: '"Tainted Love", dos Soft Cell, é uma versão. Quem gravou o original em 1964?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Dusty Springfield',
                      pt: 'Dusty Springfield',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Gloria Jones',
                      pt: 'Gloria Jones',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Martha Reeves',
                      pt: 'Martha Reeves',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Dionne Warwick',
                      pt: 'Dionne Warwick',
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
                  en: '"It\'s Raining Men" was co-written by Paul Jabara and which late-night TV bandleader?',
                  pt: '"It\'s Raining Men" foi coescrita por Paul Jabara e por que líder de banda de um talk show noturno?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Doc Severinsen',
                      pt: 'Doc Severinsen',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Kevin Eubanks',
                      pt: 'Kevin Eubanks',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Questlove',
                      pt: 'Questlove',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Paul Shaffer',
                      pt: 'Paul Shaffer',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 2000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Madonna\'s "Vogue" was first made as a B-side for another single',
                  pt: '"Vogue", da Madonna, foi feita inicialmente como lado B de outro single',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'Gloria Gaynor\'s "I Will Survive" first came out as a B-side. What was the A-side?',
                  pt: '"I Will Survive", da Gloria Gaynor, saiu primeiro como lado B. Qual era o lado A?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: '"Substitute"',
                      pt: '"Substitute"',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: '"Never Can Say Goodbye"',
                      pt: '"Never Can Say Goodbye"',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: '"Honey Bee"',
                      pt: '"Honey Bee"',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: '"Reach Out, I\'ll Be There"',
                      pt: '"Reach Out, I\'ll Be There"',
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
                type: 'type_answer',
                prompt: {
                  en: 'Which Chic guitarist co-wrote Diana Ross\'s "I\'m Coming Out" after spotting drag queens dressed as Diana at a New York club?',
                  pt: 'Que guitarrista dos Chic coescreveu "I\'m Coming Out", da Diana Ross, depois de ver drag queens vestidas de Diana numa discoteca de Nova Iorque?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Nile Rodgers',
                    pt: 'Nile Rodgers',
                  },
                },
                acceptedAnswers: [
                  'Nile Rodgers',
                  'Rodgers',
                  'Nile',
                  'Nile Rogers',
                  'Rogers',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Out and proud',
              pt: 'Fora do armário',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 250,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In July 2012, just before "Channel Orange", Frank Ocean shared an open letter about his first love, a man. Where did he post it?',
                  pt: 'Em julho de 2012, pouco antes de "Channel Orange", o Frank Ocean partilhou uma carta aberta sobre o seu primeiro amor, um homem. Onde é que a publicou?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Tumblr',
                      pt: 'Tumblr',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Instagram',
                      pt: 'Instagram',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'MySpace',
                      pt: 'MySpace',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Facebook',
                      pt: 'Facebook',
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
                  en: 'Pet Shop Boys singer Neil Tennant came out as gay in a 1994 interview with which magazine?',
                  pt: 'O vocalista dos Pet Shop Boys, Neil Tennant, assumiu-se gay numa entrevista de 1994 a que revista?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Smash Hits',
                      pt: 'Smash Hits',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Face',
                      pt: 'The Face',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Attitude',
                      pt: 'Attitude',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Rolling Stone',
                      pt: 'Rolling Stone',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 2000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year did Elton John and David Furnish enter a civil partnership in Windsor?',
                  pt: 'Em que ano é que o Elton John e o David Furnish celebraram a sua união civil em Windsor?',
                },
                options: [],
                answer: {
                  value: 2005,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'Lil Nas X came out on the last day of Pride Month in 2019',
                  pt: 'O Lil Nas X assumiu-se no último dia do mês do Orgulho de 2019',
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
                  en: 'Which openly gay disco star, born in Los Angeles and crowned the Queen of Disco, released "You Make Me Feel (Mighty Real)" in 1978?',
                  pt: 'Que estrela do disco, abertamente gay, nascida em Los Angeles e coroada Rainha do Disco, lançou "You Make Me Feel (Mighty Real)" em 1978?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Sylvester',
                    pt: 'Sylvester',
                  },
                },
                acceptedAnswers: [
                  'Sylvester',
                  'Sylvester James',
                  'Silvester',
                  'Sylvestor',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Lie Detector',
              pt: 'Detetor de Mentiras',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'In 2021, Lil Nas X\'s 666 pairs of "Satan Shoes" each had something unusual sealed inside the sole. What was it?',
                  pt: 'Em 2021, cada um dos 666 pares de "Satan Shoes" do Lil Nas X tinha algo invulgar selado dentro da sola. O que era?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Ink mixed with a drop of human blood',
                    pt: 'Tinta misturada com uma gota de sangue humano',
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
                  en: 'Before it became "Dancing Queen", what was the working title of ABBA\'s biggest dancefloor hit?',
                  pt: 'Antes de se chamar "Dancing Queen", qual era o título provisório do maior êxito de pista dos ABBA?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Boogaloo',
                    pt: 'Boogaloo',
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
                  en: 'What was Gloria Gaynor wearing when she recorded her vocal for "I Will Survive"?',
                  pt: 'O que é que a Gloria Gaynor tinha vestido quando gravou a voz de "I Will Survive"?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'A back brace, after spinal surgery',
                    pt: 'Um colete ortopédico, depois de uma cirurgia à coluna',
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
      id: 'a7e3b1c0-5eed-4000-8000-000000000009',
      cardTitle: {
        en: 'Queer TV night: spin the wheel',
        pt: 'Noite de TV queer: roda a roda',
      },
      cardDescription: {
        en: 'Sitcoms, reality TV, iconic lines, premiere dates, a Lie Detector round and spin-off pitches, and the wheel decides which round plays next',
        pt: 'Sitcoms, reality shows, falas icónicas, datas de estreia, uma ronda de Detetor de Mentiras e ideias de spin-offs, e é a roda que decide a ronda seguinte',
      },
      staffNotes:
        "Round 1, question 1: en.wikipedia.org/wiki/Queer_as_Folk_(British_TV_series): the series follows three gay men in Manchester's gay village around Canal Street\nRound 1, question 2: en.wikipedia.org/wiki/Queer_as_Folk_(British_TV_series) and hollywoodreporter.com (Russell T Davies on It's a Sin): Russell T Davies created Queer as Folk (Channel 4, 1999) and It's a Sin (Channel 4, 2021)\nRound 1, question 3: whats-on-netflix.com and geektown.co.uk (Heartstopper launch coverage, March 2022): the series is based on the graphic novels by Alice Oseman\nRound 1, question 4: en.wikipedia.org/wiki/Johnny_Rose and schitts-creek.fandom.com/wiki/David_Rose: David co-owns Rose Apothecary; Rose Video was Johnny's video rental chain, Rosebud Motel and Cafe Tropical are other town places\nRound 1, question 5: npr.org/2022/01/10/1071828269 and etonline.com: Mj Rodriguez won Best Actress in a TV Drama at the 79th Golden Globes (January 2022) for Blanca in Pose, the first trans actress to win a Golden Globe\nRound 1, question 6: en.wikipedia.org/wiki/Six_Feet_Under_(TV_series): the Fisher family run a funeral home in Los Angeles. PT title Sete Palmos de Terra per rtp.pt/programa/tv/p13799 and infopedia.pt\nRound 2, question 1: en.wikipedia.org/wiki/Queer_Eye_(2003_TV_series): original title Queer Eye for the Straight Guy, premiered on Bravo 15 July 2003\nRound 2, question 2: thewrap.com and mic.com (Netflix Queer Eye cast guides, 2017 to 2018): Jonathan Van Ness grooming, Antoni Porowski food and wine, Tan France fashion, Karamo Brown culture, Bobby Berk design\nRound 2, question 3: en.wikipedia.org/wiki/Big_Brother_(British_TV_series)_series_5 (final week: Nadia 74% to win) and en.wikipedia.org/wiki/Nadia_Almada (from Ribeira Brava, Madeira; 74% in the final two-way vote against Jason); advocate.com 2004 report on her win\nRound 2, question 4: en.wikipedia.org/wiki/Brian_Dowling_(presenter) and irishexaminer.com (Past winner is new Big Brother host): Dowling won series 2 in 2001 and was confirmed as presenter of the Channel 5 revival on 22 July 2011\nRound 2, question 5: en.wikipedia.org/wiki/I_Kissed_a_Boy_(TV_series) and thepinknews.com 2023/03/30: BBC Three dating show hosted by Dannii Minogue, first series from 13 May 2023, set in a masseria in Puglia\nRound 2, question 6: thepinknews.com 2024/01/12 and scottishnews.com: Alan Cumming has hosted The Traitors US since its 2023 launch\nRound 3, question 1: bi.org (the unicorn scale, Schitt's Creek) and identiversity.org (scene transcript) and en.wikipedia.org/wiki/List_of_Schitt's_Creek_episodes: David Rose says \"I like the wine and not the label\" to Stevie in season 1, episode 10 \"Honeymoon\"\nRound 3, question 2: en.wikipedia.org/wiki/Sophia_Petrillo and goodmorningamerica.com (Golden Girls facts): Sophia's trademark story opener is \"Picture it: Sicily, 1922\". PT title Sarilhos com Elas per magazine-hd.com (Disney+ Portugal launch)\nRound 3, question 3: en.wikipedia.org/wiki/Jack_McFarland and en.wikiquote.org (Will & Grace season 1): Jack's one-man shows include Just Jack\nRound 3, question 4: xtramagazine.com (Eleven reasons why Sex Education's Eric Effiong gives us life) and bustle.com (Ncuti Gatwa interview): Eric plays the French horn in the Moordale swing band\nRound 3, question 5: tvinsider.com (Our Flag Means Death trailer) and bellmedia.ca press release: Rhys Darby plays \"Gentleman Pirate\" Stede Bonnet, Taika Waititi plays Blackbeard\nRound 3, question 6: thepinknews.com 2005/10/18 and en.wikipedia.org/wiki/List_of_Torchwood_episodes: Torchwood (2006 to 2011) is a Doctor Who spin-off starring John Barrowman as Captain Jack Harkness\nRound 4, question 1: Will & Grace 21 Sep 1998 (rottentomatoes.com, outhistory.org); Six Feet Under 3 Jun 2001 (en.wikipedia.org/wiki/Six_Feet_Under_(TV_series)); Looking 19 Jan 2014 (tvguide.com, metacritic); Pose 3 Jun 2018 (broadwayworld.com FX press release)\nRound 4, question 2: Skins 25 Jan 2007 (en.wikipedia.org/wiki/Skins_series_1); Glee pilot 19 May 2009 (en.wikipedia.org/wiki/Pilot_(Glee)); Sex Education 11 Jan 2019 (en.wikipedia.org/wiki/Sex_Education_(TV_series)); Heartstopper 22 Apr 2022 (whats-on-netflix.com)\nRound 4, question 3: Absolutely Fabulous 12 Nov 1992 (en.wikipedia.org/wiki/Absolutely_Fabulous_series_1); Queer as Folk US 3 Dec 2000 (en.wikipedia.org/wiki/Queer_as_Folk_(American_TV_series)); Queer Eye for the Straight Guy 15 Jul 2003 (en.wikipedia.org/wiki/Queer_Eye_(2003_TV_series)); Schitt's Creek 2015 (en.wikipedia.org/wiki/List_of_Schitt's_Creek_episodes). PT title Absolutamente Fabulosas per pt.wikipedia.org/wiki/Absolutely_Fabulous (Em Portugal) and justwatch.com/pt\nRound 4, question 4: It's a Sin 22 Jan 2021 (attitude.co.uk premiere date); Somebody Somewhere 16 Jan 2022 (nexttv.com, bostonglobe.com); Our Flag Means Death 3 Mar 2022 (tvline.com, bellmedia.ca); Fellow Travelers 27 Oct 2023 on Paramount+ with Showtime, 29 Oct on Showtime (telltaletv.com, Wikipedia)\nRound 4, question 5: en.wikipedia.org/wiki/Queer_as_Folk_(British_TV_series) and attitude.co.uk: first aired on Channel 4 on 23 February 1999\nRound 4, question 6: en.wikipedia.org/wiki/List_of_Schitt's_Creek_episodes and tvseriesfinale.com: 80 episodes over six seasons, 2015 to 2020\nRound 5, question 1: empireonline.com (Russell T Davies interview), attitude.co.uk (formerly known as Boys) and gaytimes.com: working title Boys, renamed It's a Sin after the Pet Shop Boys song to avoid a clash with Amazon's The Boys. en.wikipedia.org/wiki/It's_a_Sin_(TV_series): first reported in 2018 as The Boys, the working title was clarified in early 2020 as Boys\nRound 5, question 2: en.wikipedia.org/wiki/The_Puppy_Episode and biography.com: an executive suggested Ellen Morgan get a puppy instead, and the writers used The Puppy Episode as the secret working title. Accounts differ on whether it was an ABC executive or Michael Eisner, so the truth says only \"an executive\"\nRound 5, question 3: tvinsider.com/852956 and syfy.com (Dr Clara Mandrake): Moira shoots The Crows Have Eyes III: The Crowening in Bosnia in the season 5 premiere\nRound 5, question 4: en.wikipedia.org/wiki/Modern_Mother_and_Daughter and en.wikipedia.org/wiki/Absolutely_Fabulous: Ab Fab grew out of the 1990 French and Saunders sketch, in which Dawn French played the sensible daughter\nRound 6, question 1: party prompt, no fact to check\nRound 6, question 2: party prompt, no fact to check\nRound 6, question 3: party prompt, no fact to check",
      quiz: {
        title: 'Queer TV night: spin the wheel',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'wheel',
            title: {
              en: '',
              pt: '',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Series and sitcoms',
              pt: 'Séries e sitcoms',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Queer as Folk (1999) follows three gay men around Canal Street. Which city is it set in?',
                  pt: 'Queer as Folk (1999) segue três homens gays à volta da Canal Street. Em que cidade se passa?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Leeds',
                      pt: 'Leeds',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Liverpool',
                      pt: 'Liverpool',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Manchester',
                      pt: 'Manchester',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Birmingham',
                      pt: 'Birmingham',
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
                type: 'type_answer',
                prompt: {
                  en: "Which writer created both Queer as Folk (1999) and It's a Sin (2021)?",
                  pt: "Que argumentista criou Queer as Folk (1999) e também It's a Sin (2021)?",
                },
                options: [],
                answer: {
                  text: {
                    en: 'Russell T Davies',
                    pt: 'Russell T Davies',
                  },
                },
                acceptedAnswers: [
                  'Russell T Davies',
                  'Russell T. Davies',
                  'Russell Davies',
                  'Davies',
                  'RTD',
                  'Russell',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Heartstopper is adapted from whose graphic novels?',
                  pt: 'Heartstopper é adaptada da banda desenhada de quem?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Alice Oseman',
                      pt: 'Alice Oseman',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Becky Albertalli',
                      pt: 'Becky Albertalli',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Sally Rooney',
                      pt: 'Sally Rooney',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Casey McQuiston',
                      pt: 'Casey McQuiston',
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
                  en: "In Schitt's Creek, what is the name of the shop David Rose opens?",
                  pt: "Em Schitt's Creek, como se chama a loja que o David Rose abre?",
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Rose Video',
                      pt: 'Rose Video',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Rose Apothecary',
                      pt: 'Rose Apothecary',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Café Tropical',
                      pt: 'Café Tropical',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Rosebud Motel',
                      pt: 'Rosebud Motel',
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
                type: 'true_false',
                prompt: {
                  en: 'Mj Rodriguez became the first trans actress to win a Golden Globe, for playing Blanca in Pose',
                  pt: 'Mj Rodriguez foi a primeira atriz trans a ganhar um Globo de Ouro, pelo papel de Blanca em Pose',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'In Six Feet Under, the Fisher family runs a funeral home in which city?',
                  pt: 'Em Sete Palmos de Terra, a família Fisher gere uma agência funerária em que cidade?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'San Francisco',
                      pt: 'São Francisco',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Chicago',
                      pt: 'Chicago',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Miami',
                      pt: 'Miami',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Los Angeles',
                      pt: 'Los Angeles',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Reality TV',
              pt: 'Reality shows',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: 'The original 2003 Queer Eye had a longer title. Queer Eye for the Straight...?',
                  pt: 'O Queer Eye original, de 2003, tinha um título mais comprido. Queer Eye for the Straight...?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Guy',
                    pt: 'Guy',
                  },
                },
                acceptedAnswers: [
                  'Guy',
                  'Guys',
                  'Straight Guy',
                  'the Straight Guy',
                  'Queer Eye for the Straight Guy',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 500,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "In the first season of Netflix's Queer Eye (2018), which of the Fab Five looked after grooming?",
                  pt: 'Na primeira temporada do Queer Eye da Netflix (2018), qual dos Fab Five tratava do cabelo e da pele?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Antoni Porowski',
                      pt: 'Antoni Porowski',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Tan France',
                      pt: 'Tan France',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Karamo Brown',
                      pt: 'Karamo Brown',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Jonathan Van Ness',
                      pt: 'Jonathan Van Ness',
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
                type: 'closest_number',
                prompt: {
                  en: 'Nadia Almada, from Madeira, won Big Brother UK in 2004. What percentage of the final vote did she get?',
                  pt: 'A madeirense Nadia Almada venceu o Big Brother britânico em 2004. Que percentagem dos votos da final conseguiu?',
                },
                options: [],
                answer: {
                  value: 74,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "Brian Dowling, who won Big Brother UK in 2001, later became the show's presenter",
                  pt: 'Brian Dowling, que venceu o Big Brother britânico em 2001, mais tarde passou a apresentar o programa',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'Who hosted the first series of I Kissed a Boy (2023), the BBC dating show set on an Italian farm?',
                  pt: 'Quem apresentou a primeira temporada de I Kissed a Boy (2023), o programa de encontros da BBC numa quinta italiana?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Kylie Minogue',
                      pt: 'Kylie Minogue',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Dannii Minogue',
                      pt: 'Dannii Minogue',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Alan Carr',
                      pt: 'Alan Carr',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Holly Willoughby',
                      pt: 'Holly Willoughby',
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
                  en: 'Who hosted the first season of the US version of The Traitors, in 2023?',
                  pt: 'Quem apresentou a primeira temporada da versão norte-americana de The Traitors, em 2023?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Alan Cumming',
                      pt: 'Alan Cumming',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Claudia Winkleman',
                      pt: 'Claudia Winkleman',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Andy Cohen',
                      pt: 'Andy Cohen',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Neil Patrick Harris',
                      pt: 'Neil Patrick Harris',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Iconic characters',
              pt: 'Personagens icónicas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who says "I like the wine and not the label" in Schitt\'s Creek?',
                  pt: 'Quem diz "gosto do vinho e não do rótulo" em Schitt\'s Creek?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Stevie Budd',
                      pt: 'Stevie Budd',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'David Rose',
                      pt: 'David Rose',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Patrick Brewer',
                      pt: 'Patrick Brewer',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Alexis Rose',
                      pt: 'Alexis Rose',
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
                type: 'type_answer',
                prompt: {
                  en: 'Which Golden Girl starts her stories with "Picture it: Sicily, 1922"?',
                  pt: 'Em Sarilhos com Elas, quem começa as histórias com "Imagina: Sicília, 1922"?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Sophia Petrillo',
                    pt: 'Sophia Petrillo',
                  },
                },
                acceptedAnswers: [
                  'Sophia',
                  'Sophia Petrillo',
                  'Petrillo',
                  'Sofia',
                  'Estelle Getty',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'In Will & Grace, who stages a one-man show called "Just Jack"?',
                  pt: 'Em Will & Grace, quem monta um espetáculo a solo chamado "Just Jack"?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Will Truman',
                      pt: 'Will Truman',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Karen Walker',
                      pt: 'Karen Walker',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Grace Adler',
                      pt: 'Grace Adler',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Jack McFarland',
                      pt: 'Jack McFarland',
                    },
                  },
                ],
                answer: {
                  correctIndex: 3,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 500,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'In Sex Education, Eric Effiong plays the French horn in the school band',
                  pt: 'Em Sex Education, o Eric Effiong toca trompa na banda da escola',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'In Our Flag Means Death, which character is known as "the Gentleman Pirate"?',
                  pt: 'Em Our Flag Means Death, que personagem é conhecida como "o Pirata Cavalheiro"?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Stede Bonnet',
                      pt: 'Stede Bonnet',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Blackbeard',
                      pt: 'Barba Negra',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Calico Jack',
                      pt: 'Calico Jack',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Izzy Hands',
                      pt: 'Izzy Hands',
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
                  en: 'Which Doctor Who character got his own spin-off, Torchwood, in 2006?',
                  pt: 'Que personagem de Doctor Who ganhou o seu próprio spin-off, Torchwood, em 2006?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Rory Williams',
                      pt: 'Rory Williams',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Mickey Smith',
                      pt: 'Mickey Smith',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Captain Jack Harkness',
                      pt: 'Capitão Jack Harkness',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Adam Mitchell',
                      pt: 'Adam Mitchell',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Premieres in order',
              pt: 'Estreias por ordem',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 1000,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'order',
                prompt: {
                  en: 'Put these shows in premiere order, earliest first',
                  pt: 'Põe estas séries por ordem de estreia, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Pose',
                      pt: 'Pose',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Will & Grace',
                      pt: 'Will & Grace',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Looking',
                      pt: 'Looking',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Six Feet Under',
                      pt: 'Sete Palmos de Terra',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'c', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these teen and school shows in premiere order, earliest first',
                  pt: 'Põe estas séries juvenis por ordem de estreia, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Sex Education',
                      pt: 'Sex Education',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Skins',
                      pt: 'Skins',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Heartstopper',
                      pt: 'Heartstopper',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Glee',
                      pt: 'Glee',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'a', 'c'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these shows in premiere order, earliest first',
                  pt: 'Põe estes programas por ordem de estreia, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Queer Eye for the Straight Guy',
                      pt: 'Queer Eye for the Straight Guy',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: "Schitt's Creek",
                      pt: "Schitt's Creek",
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Absolutely Fabulous',
                      pt: 'Absolutamente Fabulosas',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Queer as Folk (US)',
                      pt: 'Queer as Folk (EUA)',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'd', 'a', 'b'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Tough one: put these 2020s shows in premiere order, earliest first',
                  pt: 'Esta é difícil: põe estas séries dos anos 2020 por ordem de estreia, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Fellow Travelers',
                      pt: 'Fellow Travelers',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Our Flag Means Death',
                      pt: 'Our Flag Means Death',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: "It's a Sin",
                      pt: "It's a Sin",
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Somebody Somewhere',
                      pt: 'Somebody Somewhere',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'd', 'b', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 2000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In what year did the original Queer as Folk first air on Channel 4?',
                  pt: 'Em que ano estreou o Queer as Folk original no Channel 4?',
                },
                options: [],
                answer: {
                  value: 1999,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: "Schitt's Creek ran for six seasons, from 2015 to 2020. How many episodes did it make in total?",
                  pt: "Schitt's Creek teve seis temporadas, de 2015 a 2020. Quantos episódios teve no total?",
                },
                options: [],
                answer: {
                  value: 80,
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
              en: 'Lie Detector: TV edition',
              pt: 'Detetor: edição TV',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: "Before it was named after a Pet Shop Boys song, what was the working title of It's a Sin?",
                  pt: "Antes de ganhar o nome de uma canção dos Pet Shop Boys, qual era o título provisório de It's a Sin?",
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Boys',
                    pt: 'Boys',
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
                  en: 'Why is Ellen\'s 1997 coming-out episode called "The Puppy Episode"?',
                  pt: 'Porque é que o episódio de 1997 em que a Ellen se assume se chama "The Puppy Episode"?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'An executive suggested Ellen just get a puppy instead',
                    pt: 'Um executivo sugeriu que, em vez disso, a Ellen arranjasse um cachorrinho',
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
                  en: "In Schitt's Creek, what is the full title of the horror film Moira Rose shoots in Bosnia?",
                  pt: "Em Schitt's Creek, qual é o título completo do filme de terror que a Moira Rose roda na Bósnia?",
                },
                options: [],
                answer: {
                  truth: {
                    en: 'The Crows Have Eyes III: The Crowening',
                    pt: 'The Crows Have Eyes III: The Crowening',
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
                  en: 'Absolutely Fabulous grew out of a 1990 sketch. Who played the sensible daughter in it?',
                  pt: 'Absolutamente Fabulosas nasceu de um sketch de 1990. Quem fazia de filha certinha nesse sketch?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Dawn French',
                    pt: 'Dawn French',
                  },
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
              en: 'Name the spin-off',
              pt: 'Inventa o spin-off',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Give your favourite TV side character their own queer spin-off. What is the show called?',
                  pt: 'Dá à tua personagem secundária preferida o seu próprio spin-off queer. Como se chama a série?',
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
                  en: 'A new queer dating reality show is filming in a palace in Sintra. What is it called?',
                  pt: 'Um novo reality show de encontros queer está a ser gravado num palácio em Sintra. Como se chama?',
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
                  en: 'Your life is now a sitcom named after your street and your worst habit. What is it called?',
                  pt: 'A tua vida é agora uma sitcom com o nome da tua rua e do teu pior hábito. Como se chama?',
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
      id: 'a7e3b1c0-5eed-4000-8000-00000000000a',
      cardTitle: {
        en: 'Screen icons: spin the wheel',
        pt: 'Ícones do ecrã: gira a roda',
      },
      cardDescription: {
        en: 'Queer film and the screen legends we adore: award nights, sets, characters, directors and numbers, plus a Lie Detector twist, and a wheel picks the category for every question',
        pt: 'Cinema queer e as lendas do ecrã que adoramos: prémios, bastidores, personagens, realizadores e números, com um Detetor de Mentiras pelo meio, e uma roda escolhe a categoria de cada pergunta',
      },
      staffNotes:
        "Round 1, question 1: Guinness World Records 'most consecutive Best Actor Oscar wins' and faroutmagazine.co.uk: Tom Hanks won Best Actor for Philadelphia (1994 ceremony) and Forrest Gump (1995 ceremony)\nRound 1, question 2: Guinness World Records 'Oldest Oscar winner' and TheWrap / ET Online, March 2018: James Ivory won Best Adapted Screenplay for Call Me by Your Name at 89, the oldest competitive Oscar winner on record at the time (beating Ennio Morricone, 87). PT title 'Chama-me pelo Teu Nome' (Público Cinecartaz)\nRound 1, question 3: Wikipedia 'A Fantastic Woman' and MercoPress 5 March 2018: first Chilean winner of Best Foreign Language Film (Chile's earlier Oscar was Bear Story, animated short, 2016)\nRound 1, question 4: Wikipedia 'Teddy Award' winners table and teddyaward.tv archive: the first Teddy (1987) Best Feature Film went to Almodóvar's Law of Desire; the only other 1987 Teddy went to Gus Van Sant's shorts (kept out of the options). Jarman (1988), von Praunheim (1990) and Ozon (2000) won in later years\nRound 1, question 5: festival-cannes.com 'Happy Together' and SCMP: Wong Kar-wai won Best Director at Cannes 1997 for Happy Together. Portugal titles: 'Disponível para Amar' (Cinema Trindade, JustWatch PT, Leopardo Filmes) and 'Felizes Juntos' (Cinema Trindade, Teatro Municipal do Porto, Time Out Lisboa); Chungking Express keeps its title in Portugal (pt.wikipedia)\nRound 2, question 1: Wikipedia 'Call Me by Your Name (film)' and movie-locations.com: shot mainly in Crema, Lombardy, May to June 2016 (villa in nearby Moscazzano)\nRound 2, question 2: Wikipedia 'Weekend (2011 film)', Screen Daily Oct 2010 and Filmmaker Magazine interview: shot on location in Nottingham\nRound 2, question 3: Wikipedia 'Fire Island (film)' and NPR Fresh Air 27 June 2022: Joel Kim Booster's film is a modern retelling of Jane Austen's Pride and Prejudice. Portugal title 'Fire Island: Orgulho & Sedução' (JustWatch PT, Disney+)\nRound 2, question 4: Country & Town House, Homes & Gardens, ITV News Anglia Feb 2024: Saltburn's estate is Drayton House, Lowick, Northamptonshire\nRound 2, question 5: Wikipedia 'Ruby slippers' and Mental Floss: in Baum's 1900 book the shoes are silver; MGM made them ruby for Technicolor (statement is FALSE)\nRound 3, question 1: Wikipedia 'The Adventures of Priscilla, Queen of the Desert' and TV Insider cast list: Terence Stamp plays Bernadette Bassenger. Portugal title 'Priscilla, a Rainha do Deserto' (Público Cinecartaz; JustWatch PT lists it without the article)\nRound 3, question 2: Wikipedia 'Some Like It Hot' cast list and Rotten Tomatoes: Jack Lemmon plays Jerry/Daphne, Tony Curtis plays Joe/Josephine. Portugal title 'Quanto Mais Quente Melhor' (Público Cinecartaz)\nRound 3, question 3: Roger Ebert review and Wikipedia 'The Birdcage': Nathan Lane plays Albert, Robin Williams plays Armand. PT title 'Casa de Doidas' (pt.wikipedia infobox, prt)\nRound 3, question 4: Wikipedia 'Death Becomes Her' and AFI Catalog: Meryl Streep plays Madeline Ashton, Goldie Hawn plays Helen Sharp (statement is FALSE). Portugal title 'A Morte Fica-Vos Tão Bem' (pt.wikipedia)\nRound 3, question 5: Wikipedia 'Love, Simon' and Elite Daily: Bram Greenfeld (Keiynan Lonsdale) is revealed as Blue. Portugal title 'Com Amor, Simon' (pt.wikipedia)\nRound 4, question 1: Wikipedia 'Milk (2008 American film)' and 'List of accolades received by Milk': directed by Gus Van Sant\nRound 4, question 2: Wikipedia 'John Waters' and American University library guide: Waters directed Divine in Pink Flamingos (1972), Female Trouble (1974) and Hairspray (1988). Portugal title of Hairspray (1988) is 'Laca' (Público Cinecartaz, pt.wikipedia)\nRound 4, question 3: BFI 'Blue at 30: remembering Derek Jarman's final film' and Walker Art Center: Blue is a single unchanging International Klein Blue image for the whole film (statement is TRUE)\nRound 4, question 4: Wikipedia 'Weekend (2011 film)' and 'All of Us Strangers', Criterion: both written and directed by Andrew Haigh. All of Us Strangers went straight to Disney+ in Portugal as 'Desconhecidos' (Magazine HD, JustWatch PT); Weekend kept its title in Portugal (DN, Queer Lisboa 16 opening film)\nRound 4, question 5: Criterion Channel and TCM 'Velvet Goldmine': 1998 glam rock film directed by Todd Haynes with Ewan McGregor and Jonathan Rhys Meyers. Portugal titles 'Velvet Goldmine' and 'Hedwig - A Origem do Amor' (Público Cinecartaz)\nRound 5, question 1: Wikipedia 'The Rocky Horror Picture Show' and Click Americana: released 14 August 1975 (London)\nRound 5, question 2: Judy Garland born 10 June 1922 (Wikipedia 'Judy Garland'); The Wizard of Oz opened in August 1939 (Wikipedia 'The Wizard of Oz (1939 film)'), so she was 17. PT title 'O Feiticeiro de Oz'\nRound 5, question 3: release years from Wikipedia: Some Like It Hot 1959, Mommie Dearest Sept 1981, Priscilla Aug 1994, Pride Sept 2014, Saltburn 2023. Portugal titles 'Quanto Mais Quente Melhor', 'Priscilla, a Rainha do Deserto' and 'Orgulho' (Público Cinecartaz), 'Queridíssima Mamã' (pt.wikipedia)\nRound 5, question 4: TCM 'Cabaret (1972)' and Library of Congress blog: Cabaret won 8 Oscars, incl. Best Actress for Liza Minnelli\nRound 5, question 5: Slashfilm Sundance 2015 report and American Cinematographer (theasc.com): Tangerine was shot on iPhone 5s phones and the filmmakers bought three for the shoot (two filmed at a time)\nRound 6, question 1: Wikipedia 'American Express Gold Card dress' and The Virginian-Pilot 29 March 1995: Lizzy Gardiner wore a dress of 254 gold American Express cards to collect her Priscilla costume Oscar\nRound 6, question 2: Wikipedia 'Joan Crawford' and 'Alfred Steele': after Steele died in 1959 Crawford was elected to the Pepsi-Cola board, retiring in 1973\nRound 6, question 3: Wikipedia 'Terry (dog)' and NPR 25 Aug 2014 'How Terry the terrier became Toto': the dog who played Toto was a female Cairn Terrier named Terry",
      quiz: {
        title: 'Screen icons: spin the wheel',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'wheel',
            title: {
              en: '',
              pt: '',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'question',
              sliceCount: null,
            },
            questions: [],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Awards night',
              pt: 'Noite de prémios',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 250,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Tom Hanks won Best Actor for Philadelphia. For which film did he win it again the very next year?',
                  pt: 'Tom Hanks ganhou o Óscar de Melhor Ator por Filadélfia. Com que filme voltou a ganhá-lo logo no ano seguinte?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Apollo 13',
                      pt: 'Apollo 13',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Forrest Gump',
                      pt: 'Forrest Gump',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Big',
                      pt: 'Big',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Cast Away',
                      pt: 'O Náufrago',
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
                type: 'type_answer',
                prompt: {
                  en: 'At 89, who became the oldest competitive Oscar winner on record at the time, for adapting Call Me by Your Name?',
                  pt: 'Aos 89 anos, quem se tornou a pessoa mais velha de sempre a ganhar um Óscar competitivo, até então, pela adaptação de Chama-me pelo Teu Nome?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'James Ivory',
                    pt: 'James Ivory',
                  },
                },
                acceptedAnswers: [
                  'Ivory',
                  'James Ivory',
                  'Jim Ivory',
                  'J. Ivory',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 2000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: 'A Fantastic Woman won Chile its first Oscar for Best Foreign Language Film',
                  pt: 'Uma Mulher Fantástica deu ao Chile o seu primeiro Óscar de Melhor Filme Estrangeiro',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'The very first Teddy Award at the Berlin film festival, in 1987, went to Law of Desire. Who directed it?',
                  pt: 'O primeiro Teddy Award de sempre, no festival de cinema de Berlim em 1987, foi para A Lei do Desejo. Quem o realizou?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Derek Jarman',
                      pt: 'Derek Jarman',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Rosa von Praunheim',
                      pt: 'Rosa von Praunheim',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Pedro Almodóvar',
                      pt: 'Pedro Almodóvar',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'François Ozon',
                      pt: 'François Ozon',
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
                  en: 'Wong Kar-wai won Best Director at Cannes in 1997. For which film?',
                  pt: 'Wong Kar-wai ganhou o prémio de Melhor Realizador em Cannes em 1997. Com que filme?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'In the Mood for Love',
                      pt: 'Disponível para Amar',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Chungking Express',
                      pt: 'Chungking Express',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: '2046',
                      pt: '2046',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Happy Together',
                      pt: 'Felizes Juntos',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Behind the scenes',
              pt: 'Bastidores',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Call Me by Your Name was mainly shot in and around which small Lombardy town?',
                  pt: 'Chama-me Pelo Teu Nome foi filmado sobretudo dentro e à volta de que pequena cidade da Lombardia?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Crema',
                      pt: 'Crema',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Como',
                      pt: 'Como',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Verona',
                      pt: 'Verona',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Mantua',
                      pt: 'Mântua',
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
                  en: "Andrew Haigh's Weekend (2011) was shot on location in Nottingham",
                  pt: 'Weekend (2011), de Andrew Haigh, foi filmado em Nottingham',
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
                  en: 'Fire Island (2022) is a modern queer retelling of which Jane Austen novel?',
                  pt: 'Fire Island: Orgulho & Sedução (2022) é uma versão queer e moderna de que romance de Jane Austen?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Pride and Prejudice',
                    pt: 'Orgulho e Preconceito',
                  },
                },
                acceptedAnswers: [
                  'Pride and Prejudice',
                  'Pride & Prejudice',
                  'Pride and Predjudice',
                  'Orgulho e Preconceito',
                  'Orgulho e Preconceitos',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: "Which English stately home played the Saltburn estate in Emerald Fennell's film?",
                  pt: 'Que mansão inglesa fez de propriedade de Saltburn no filme de Emerald Fennell?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Highclere Castle',
                      pt: 'Highclere Castle',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Castle Howard',
                      pt: 'Castle Howard',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Drayton House',
                      pt: 'Drayton House',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Chatsworth House',
                      pt: 'Chatsworth House',
                    },
                  },
                ],
                answer: {
                  correctIndex: 2,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 2000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "In L. Frank Baum's original book, Dorothy's magic shoes are ruby red",
                  pt: 'No livro original de L. Frank Baum, os sapatos mágicos da Dorothy são vermelho-rubi',
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
              en: 'Characters',
              pt: 'Personagens',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Which character does Terence Stamp play in Priscilla, Queen of the Desert?',
                  pt: 'Que personagem interpreta Terence Stamp em Priscilla, a Rainha do Deserto?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Felicia',
                      pt: 'Felicia',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Mitzi',
                      pt: 'Mitzi',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Priscilla',
                      pt: 'Priscilla',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Bernadette',
                      pt: 'Bernadette',
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
                  en: "In Some Like It Hot, what name does Jack Lemmon's Jerry go by in the all-girl band?",
                  pt: 'Em Quanto Mais Quente Melhor, que nome usa o Jerry de Jack Lemmon na banda só de raparigas?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Daphne',
                      pt: 'Daphne',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Josephine',
                      pt: 'Josephine',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Sugar',
                      pt: 'Sugar',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Roberta',
                      pt: 'Roberta',
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
                  en: 'Who plays Albert, the drag star of the club, in The Birdcage (1996)?',
                  pt: 'Quem interpreta Albert, a estrela drag do clube, em Casa de Doidas (1996)?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Robin Williams',
                      pt: 'Robin Williams',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Nathan Lane',
                      pt: 'Nathan Lane',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Gene Hackman',
                      pt: 'Gene Hackman',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Hank Azaria',
                      pt: 'Hank Azaria',
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
                type: 'true_false',
                prompt: {
                  en: "In Death Becomes Her, Meryl Streep's character is called Helen Sharp",
                  pt: 'Em A Morte Fica-Vos Tão Bem, a personagem de Meryl Streep chama-se Helen Sharp',
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
                type: 'type_answer',
                prompt: {
                  en: "In Love, Simon, which classmate turns out to be Blue, Simon's secret pen pal?",
                  pt: 'Em Com Amor, Simon, que colega de escola se revela ser o Blue, o correspondente secreto do Simon?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Bram',
                    pt: 'Bram',
                  },
                },
                acceptedAnswers: [
                  'Bram',
                  'Bram Greenfeld',
                  'Greenfeld',
                  'Bram Greenfield',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Directors',
              pt: 'Realizadores',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 250,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'Who directed Milk (2008), starring Sean Penn as Harvey Milk?',
                  pt: 'Quem realizou Milk (2008), com Sean Penn no papel de Harvey Milk?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Todd Haynes',
                      pt: 'Todd Haynes',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Jonathan Demme',
                      pt: 'Jonathan Demme',
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
                      en: 'Ang Lee',
                      pt: 'Ang Lee',
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
                type: 'type_answer',
                prompt: {
                  en: 'Which Baltimore director cast Divine in Pink Flamingos, Female Trouble and Hairspray?',
                  pt: 'Que realizador de Baltimore escolheu Divine para Pink Flamingos, Female Trouble e Laca (Hairspray)?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'John Waters',
                    pt: 'John Waters',
                  },
                },
                acceptedAnswers: ['Waters', 'John Waters', 'Jon Waters'],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "Derek Jarman's final feature, Blue (1993), shows one unchanging shade of blue for its whole running time",
                  pt: 'A última longa-metragem de Derek Jarman, Blue (1993), mostra um único tom de azul do princípio ao fim',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'Which director made both Weekend (2011) and All of Us Strangers (2023)?',
                  pt: 'Que realizador fez Weekend (2011) e Desconhecidos (2023)?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Andrew Haigh',
                      pt: 'Andrew Haigh',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Francis Lee',
                      pt: 'Francis Lee',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Luca Guadagnino',
                      pt: 'Luca Guadagnino',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Stephen Daldry',
                      pt: 'Stephen Daldry',
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
                  en: 'Todd Haynes directed which 1998 glam rock film with Ewan McGregor and Jonathan Rhys Meyers?',
                  pt: 'Todd Haynes realizou que filme de glam rock de 1998, com Ewan McGregor e Jonathan Rhys Meyers?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Rocketman',
                      pt: 'Rocketman',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Velvet Goldmine',
                      pt: 'Velvet Goldmine',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Hedwig and the Angry Inch',
                      pt: 'Hedwig: A Origem do Amor',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Bohemian Rhapsody',
                      pt: 'Bohemian Rhapsody',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'By the numbers',
              pt: 'Em números',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'closest_number',
                prompt: {
                  en: 'In what year was The Rocky Horror Picture Show released?',
                  pt: 'Em que ano estreou The Rocky Horror Picture Show?',
                },
                options: [],
                answer: {
                  value: 1975,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How old was Judy Garland when The Wizard of Oz opened in cinemas in August 1939?',
                  pt: 'Que idade tinha Judy Garland quando O Feiticeiro de Oz estreou nos cinemas, em agosto de 1939?',
                },
                options: [],
                answer: {
                  value: 17,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these films in order of release, earliest first',
                  pt: 'Põe estes filmes por ordem de estreia, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Pride',
                      pt: 'Orgulho',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Some Like It Hot',
                      pt: 'Quanto Mais Quente Melhor',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Saltburn',
                      pt: 'Saltburn',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Priscilla, Queen of the Desert',
                      pt: 'Priscilla, a Rainha do Deserto',
                    },
                  },
                  {
                    id: 'e',
                    text: {
                      en: 'Mommie Dearest',
                      pt: 'Queridíssima Mamã',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'e', 'd', 'a', 'c'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How many Oscars did Cabaret (1972), starring Liza Minnelli, win?',
                  pt: 'Quantos Óscares ganhou Cabaret (1972), com Liza Minnelli?',
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
                  en: 'Tangerine (2015) was shot on iPhone 5s phones. How many did the filmmakers buy for the shoot?',
                  pt: 'Tangerine (2015) foi filmado com iPhones 5s. Quantos comprou a equipa para a rodagem?',
                },
                options: [],
                answer: {
                  value: 3,
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
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: "Priscilla's costume designer Lizzy Gardiner collected her Oscar in a dress made of what?",
                  pt: 'A figurinista de Priscilla, Lizzy Gardiner, foi buscar o Óscar com um vestido feito de quê?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Gold American Express cards',
                    pt: 'Cartões American Express dourados',
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
                  en: 'After her husband died in 1959, Joan Crawford joined the board of directors of which company?',
                  pt: 'Depois de o marido morrer em 1959, Joan Crawford entrou para o conselho de administração de que empresa?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Pepsi-Cola',
                    pt: 'Pepsi-Cola',
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
                  en: 'What was the real name of the dog who played Toto in The Wizard of Oz?',
                  pt: 'Qual era o verdadeiro nome da cadela que fez de Toto em O Feiticeiro de Oz?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Terry',
                    pt: 'Terry',
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
      id: 'a7e3b1c0-5eed-4000-8000-00000000000b',
      cardTitle: {
        en: 'Sapphic night: spin the wheel',
        pt: 'Noite sáfica: gira a roda',
      },
      cardDescription: {
        en: 'Sapphic films and series, music, history, milestones in order, a Lie Detector round and drag king names, and the wheel decides which round plays next',
        pt: 'Filmes e séries sáficas, música, história, marcos por ordem, uma ronda de Detetor de Mentiras e nomes de drag king, e a roda decide que ronda se joga a seguir',
      },
      staffNotes:
        "Round 1, question 1: Wikipedia, The L Word and OutHistory (Rob Frydlewicz, 'Queer as Folk begets The L Word'): series about lesbian and bisexual friends set in West Hollywood, Los Angeles (filmed mostly in Vancouver)\nRound 1, question 2: Wikipedia, Carol (film) and thecinemaholic.com 'Is Frankenberg's a real department store?': Therese works in the toy department at Frankenberg's and sells Carol a train set; Carol leaves her gloves on the counter (why gloves is a distractor). PT title is also Carol\nRound 1, question 3: Wikipedia, Villanelle (character) and Codename Villanelle: Villanelle is the codename of Oksana Astankova, played by Jodie Comer\nRound 1, question 4: Film at Lincoln Center listing, Korea Times (2 May 2016) and Wikipedia, The Handmaiden: Park Chan-wook's film adapts Sarah Waters's Fingersmith, moved to 1930s Japanese-occupied Korea. Official PT title A Criada (Time Out Portugal, estreia 14 April 2017). Distractors are other Sarah Waters novels\nRound 1, question 5: Wikipedia, Bound (1996 film): written and directed by the Wachowskis, their feature directorial debut, with Gina Gershon and Jennifer Tilly. No confirmed Portugal release title found (AdoroCinema's 'Ligadas pelo Desejo' is Brazilian), so the original title is used (Queer Lisboa 26 screened it as Bound, Magazine HD)\nRound 1, question 6: Wikipedia, Orange Is the New Black and TV Guide 'Laura Prepon on Alex and Piper': Alex Vause is played by Laura Prepon; Taylor Schilling plays Piper Chapman, so the statement is FALSE. PT title is the original (Netflix Portugal)\nRound 2, question 1: Grammy.com artist page and Wikipedia: Chappell Roan's debut album The Rise and Fall of a Midwest Princess was released 22 September 2023; she won Best New Artist at the 2025 Grammys\nRound 2, question 2: Grammy.com, 35th Grammy Awards (1993), Best Female Pop Vocal Performance: k.d. lang won for Constant Craving (from Ingenue). Crying (with Roy Orbison) won a country collaboration Grammy in 1989, a different category\nRound 2, question 3: NME 'Who is Hayley Kiyoko, and why are people calling her the Lesbian Jesus?' and Refinery29 (March 2018): fans nicknamed Hayley Kiyoko 'Lesbian Jesus' and she embraces it\nRound 2, question 4: Wikipedia, Girl in Red and NPR interview (2 May 2021): Marie Ulven Ringheim, born in Horten, Norway; 'Do you listen to girl in red?' became a TikTok code for asking if someone likes girls\nRound 2, question 5: AARP 'Melissa Etheridge National Coming Out Day' and In Magazine 'Flashback: Melissa Etheridge comes out as a lesbian, January 20 1993': she came out at the Triangle Ball, an LGBTQ inaugural ball for Bill Clinton. TRUE\nRound 2, question 6: Wikipedia, 1950 (song) and Songfacts: King Princess's 2018 debut single 1950 is a tribute to Patricia Highsmith's The Price of Salt (the novel behind Carol)\nRound 3, question 1: Encyclopaedia Britannica, Sappho: the archaic Greek poet lived on Lesbos, the origin of the words 'lesbian' and 'sapphic'\nRound 3, question 2: OutHistory 'Daughters of Bilitis founded' and History.com 'Daughters of Bilitis, first lesbian rights group, founded': founded in San Francisco in 1955 by Del Martin, Phyllis Lyon and other couples\nRound 3, question 3: UNESCO UK, 'Diaries of Anne Lister' (Memory of the World, national register, inscribed 2011, nominated by West Yorkshire Archive Service). TRUE\nRound 3, question 4: Wikipedia and Britannica, The Autobiography of Alice B. Toklas: written by Gertrude Stein in Toklas's voice, published 1933. Other options are real Stein works\nRound 3, question 5: Wikipedia, Lesbian flags, and Rutgers Libraries labrys guide: the labrys, a double-headed axe from Minoan Crete, was adopted by lesbian feminists in the 1970s\nRound 3, question 6: Wikipedia, Lesbian Visibility Week and Novia University of Applied Sciences news (2022): International Lesbian Visibility Day is 26 April. Brazil has a separate national day on 29 August, which is why the prompt says International\nRound 4, question 1: Wikipedia film pages: Desert Hearts (1985, Locarno and Telluride), But I'm a Cheerleader (1999, TIFF premiere), Saving Face (premiered TIFF September 2004, released May 2005), Pariah (Sundance January 2011), Carol (2015). Original titles used: no confirmed Portugal release titles found for these except Carol (Carol)\nRound 4, question 2: Wikipedia song pages: Come to My Window (1993), Closer by Tegan and Sara (single 25 September 2012), Girls Like Girls (2015), we fell in love in october (EP 21 November 2018, AllMusic), Good Luck, Babe! (5 April 2024)\nRound 4, question 3: Anne Lister and Ann Walker took communion at Holy Trinity, Goodramgate, York on Easter Sunday 30 March 1834 (Wikipedia, Ann Walker; National Archives blog); The Well of Loneliness trial, Bow Street, November 1928 (Open University Law School, 'DPP v Jonathan Cape'); Daughters of Bilitis 1955 (OutHistory); Zami: A New Spelling of My Name 1982 (Wikipedia, Crossing Press first edition); Lesbian Avengers founded in New York in 1992 (Wikipedia, Lesbian Avengers)\nRound 4, question 4: Wikipedia, The L Word and OutHistory: first broadcast on Showtime on 18 January 2004\nRound 4, question 5: Guinness World Records 'Most Wimbledon singles titles won by a woman' and Wimbledon.com 1990s history: nine titles (1978, 1979, 1982 to 1987, 1990)\nRound 4, question 6: WTA legends page and International Tennis Hall of Fame: Amelie Mauresmo won the 2006 Australian Open and 2006 Wimbledon, her only two major singles titles\nRound 5, question 1: History.com 'Billie Jean King wins the Battle of the Sexes' and Wikipedia, Battle of the Sexes (tennis): Riggs gave King a giant Sugar Daddy lollipop, she gave him a piglet (Houston Astrodome, 20 September 1973)\nRound 5, question 2: Wikipedia, Lesbian Avengers and Gay City News 'The legacy of the fire eating Lesbian Avengers': fire-eating became their signature act from 30 October 1992 in New York, honouring Hattie Mae Cohens and Brian Mock\nRound 5, question 3: The Conversation, Paul Baker (Lancaster University, historian of Section 28) 'LGBT history: the bold, very British resistance to section 28': the women tied lengths of clothesline round their waists and climbed down them from the gallery (House of Lords, 2 February 1988); Herts Memories 'Sally Francis, Section 28 activist' and Attitude (Sally Francis, one of the abseilers): a washing line bought at Clapham market on the way in\nRound 5, question 4: PinkNews (25 July 2018) and Stylist: York Civic Trust's first rainbow plaque at Holy Trinity, Goodramgate called Anne Lister a 'gender-nonconforming entrepreneur'; after a petition it was reworded with 'lesbian' (YorkMix, February 2019)\nRound 6, question 1: party prompt, no fact to check\nRound 6, question 2: party prompt, no fact to check\nRound 6, question 3: party prompt, no fact to check",
      quiz: {
        title: 'Sapphic night: spin the wheel',
        languages: 'both',
        screenLanguage: 'en',
        rounds: [
          {
            kind: 'wheel',
            title: {
              en: '',
              pt: '',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Sapphic screen',
              pt: 'Ecrã sáfico',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'The L Word followed a group of lesbian and bisexual friends in which city?',
                  pt: 'The L Word seguia um grupo de amigas lésbicas e bissexuais em que cidade?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'San Francisco',
                      pt: 'São Francisco',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Los Angeles',
                      pt: 'Los Angeles',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'New York',
                      pt: 'Nova Iorque',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Chicago',
                      pt: 'Chicago',
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
                  en: 'In Carol, Therese is working behind a department store counter when Carol walks up. Which department?',
                  pt: 'Em Carol, a Therese está a trabalhar ao balcão de um grande armazém quando a Carol aparece. Em que secção?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Perfume',
                      pt: 'Perfumaria',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Gloves',
                      pt: 'Luvas',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Toys',
                      pt: 'Brinquedos',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Books',
                      pt: 'Livros',
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
                type: 'type_answer',
                prompt: {
                  en: 'In Killing Eve, what is the codename of the assassin played by Jodie Comer?',
                  pt: 'Em Killing Eve, qual é o nome de código da assassina interpretada por Jodie Comer?',
                },
                options: [],
                answer: {
                  text: {
                    en: 'Villanelle',
                    pt: 'Villanelle',
                  },
                },
                acceptedAnswers: [
                  'Villanelle',
                  'Vilanelle',
                  'Villanele',
                  'Villanel',
                  'Vilanele',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'The Handmaiden moves a Sarah Waters novel from Victorian England to 1930s Korea. Which novel?',
                  pt: 'A Criada leva um romance de Sarah Waters da Inglaterra vitoriana para a Coreia dos anos 30. Que romance?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Tipping the Velvet',
                      pt: 'Tipping the Velvet',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Affinity',
                      pt: 'Affinity',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Night Watch',
                      pt: 'The Night Watch',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Fingersmith',
                      pt: 'Fingersmith',
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
                  en: 'Bound (1996), the neo-noir with Gina Gershon and Jennifer Tilly, was the first feature directed by which duo?',
                  pt: 'Bound (1996), o neo-noir com Gina Gershon e Jennifer Tilly, foi a primeira longa-metragem realizada por que dupla?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'The Wachowskis',
                      pt: 'As Wachowski',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Coen brothers',
                      pt: 'Os irmãos Coen',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Russo brothers',
                      pt: 'Os irmãos Russo',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The Safdie brothers',
                      pt: 'Os irmãos Safdie',
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
                  en: "In Orange Is the New Black, Piper's ex Alex Vause is played by Taylor Schilling",
                  pt: 'Em Orange Is the New Black, a Alex Vause, ex da Piper, é interpretada por Taylor Schilling',
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
              en: 'Sapphic sounds',
              pt: 'Sons sáficos',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'multiple_choice',
                prompt: {
                  en: "Chappell Roan's 2023 debut album is called The Rise and Fall of a Midwest what?",
                  pt: 'O álbum de estreia de Chappell Roan, de 2023, chama-se The Rise and Fall of a Midwest quê?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Queen',
                      pt: 'Queen',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Princess',
                      pt: 'Princess',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Cowgirl',
                      pt: 'Cowgirl',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Sweetheart',
                      pt: 'Sweetheart',
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
                  en: 'Which k.d. lang song won the 1993 Grammy for Best Female Pop Vocal Performance?',
                  pt: 'Que canção de k.d. lang ganhou o Grammy de 1993 para Melhor Interpretação Vocal Pop Feminina?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Miss Chatelaine',
                      pt: 'Miss Chatelaine',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Hallelujah',
                      pt: 'Hallelujah',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Crying',
                      pt: 'Crying',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Constant Craving',
                      pt: 'Constant Craving',
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
                  en: "Which artist has been affectionately nicknamed 'Lesbian Jesus' by fans?",
                  pt: "Que artista foi carinhosamente apelidada de 'Lesbian Jesus' pelos fãs?",
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Chappell Roan',
                      pt: 'Chappell Roan',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Janelle Monáe',
                      pt: 'Janelle Monáe',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Hayley Kiyoko',
                      pt: 'Hayley Kiyoko',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Tegan Quin',
                      pt: 'Tegan Quin',
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
                type: 'type_answer',
                prompt: {
                  en: "girl in red, whose fans turned 'Do you listen to girl in red?' into a secret code, comes from which country?",
                  pt: "girl in red, cujos fãs transformaram 'Ouves girl in red?' num código secreto, é de que país?",
                },
                options: [],
                answer: {
                  text: {
                    en: 'Norway',
                    pt: 'Noruega',
                  },
                },
                acceptedAnswers: [
                  'Norway',
                  'Noruega',
                  'Norge',
                  'Norwegian',
                  'Norueguesa',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
              {
                type: 'true_false',
                prompt: {
                  en: "Melissa Etheridge came out publicly at an LGBTQ+ ball celebrating Bill Clinton's 1993 inauguration",
                  pt: 'Melissa Etheridge assumiu-se publicamente num baile LGBTQ+ que celebrava a tomada de posse de Bill Clinton em 1993',
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
                type: 'multiple_choice',
                prompt: {
                  en: "King Princess's breakout single 1950 was inspired by which novel?",
                  pt: 'O single que lançou King Princess, 1950, foi inspirado em que romance?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'The Price of Salt',
                      pt: 'The Price of Salt',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Rubyfruit Jungle',
                      pt: 'Rubyfruit Jungle',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Orlando',
                      pt: 'Orlando',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'The Well of Loneliness',
                      pt: 'The Well of Loneliness',
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
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Herstory',
              pt: 'História delas',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 500,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'type_answer',
                prompt: {
                  en: "The word 'lesbian' comes from the Greek island where the poet Sappho lived. Which island?",
                  pt: "A palavra 'lésbica' vem da ilha grega onde viveu a poetisa Safo. Que ilha?",
                },
                options: [],
                answer: {
                  text: {
                    en: 'Lesbos',
                    pt: 'Lesbos',
                  },
                },
                acceptedAnswers: [
                  'Lesbos',
                  'Lesvos',
                  'Lésbos',
                  'Lesbo',
                  'Lesvo',
                  'Lezbos',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 500,
              },
              {
                type: 'multiple_choice',
                prompt: {
                  en: 'The Daughters of Bilitis, founded in 1955 by Del Martin, Phyllis Lyon and friends, started in which city?',
                  pt: 'As Daughters of Bilitis, fundadas em 1955 por Del Martin, Phyllis Lyon e amigas, nasceram em que cidade?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'New York',
                      pt: 'Nova Iorque',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'San Francisco',
                      pt: 'São Francisco',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Chicago',
                      pt: 'Chicago',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Boston',
                      pt: 'Boston',
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
                type: 'true_false',
                prompt: {
                  en: "Anne Lister's diaries were added to UNESCO's UK Memory of the World register in 2011",
                  pt: 'Os diários de Anne Lister entraram no registo Memória do Mundo da UNESCO no Reino Unido em 2011',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'Gertrude Stein told her own life story in the voice of her partner. What is the book called?',
                  pt: 'Gertrude Stein contou a sua própria vida na voz da companheira. Como se chama o livro?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Tender Buttons',
                      pt: 'Tender Buttons',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Making of Americans',
                      pt: 'The Making of Americans',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'The Autobiography of Alice B. Toklas',
                      pt: 'The Autobiography of Alice B. Toklas',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Paris France',
                      pt: 'Paris France',
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
                  en: 'The labrys, adopted as a lesbian feminist symbol in the 1970s, is what kind of object?',
                  pt: 'O lábris, adotado como símbolo lésbico feminista nos anos 70, é que tipo de objeto?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'A crescent moon',
                      pt: 'Uma lua crescente',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'A violet',
                      pt: 'Uma violeta',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'A key',
                      pt: 'Uma chave',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'A double-headed axe',
                      pt: 'Um machado de dois gumes',
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
                type: 'type_answer',
                prompt: {
                  en: 'On which date is International Lesbian Visibility Day celebrated each year?',
                  pt: 'Em que dia se celebra todos os anos o Dia Internacional da Visibilidade Lésbica?',
                },
                options: [],
                answer: {
                  text: {
                    en: '26 April',
                    pt: '26 de abril',
                  },
                },
                acceptedAnswers: [
                  '26 April',
                  'April 26',
                  '26th April',
                  'April 26th',
                  '26/04',
                  '26.04',
                  '26 de abril',
                  '26 abril',
                  '26 de Abril',
                  '26-04',
                ],
                mediaRef: null,
                timeLimitSeconds: 25,
                points: 1000,
              },
            ],
          },
          {
            kind: 'quiz',
            title: {
              en: 'Firsts in order',
              pt: 'Marcos por ordem',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 1000,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'order',
                prompt: {
                  en: 'Put these sapphic films in release order, earliest first',
                  pt: 'Põe estes filmes sáficos por ordem de estreia, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Carol',
                      pt: 'Carol',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Desert Hearts',
                      pt: 'Desert Hearts',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Pariah',
                      pt: 'Pariah',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: "But I'm a Cheerleader",
                      pt: "But I'm a Cheerleader",
                    },
                  },
                  {
                    id: 'e',
                    text: {
                      en: 'Saving Face',
                      pt: 'Saving Face',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'd', 'e', 'c', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 1000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these sapphic songs in release order, earliest first',
                  pt: 'Põe estas canções sáficas por ordem de lançamento, da mais antiga para a mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Good Luck, Babe! (Chappell Roan)',
                      pt: 'Good Luck, Babe! (Chappell Roan)',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Come to My Window (Melissa Etheridge)',
                      pt: 'Come to My Window (Melissa Etheridge)',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Girls Like Girls (Hayley Kiyoko)',
                      pt: 'Girls Like Girls (Hayley Kiyoko)',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'we fell in love in october (girl in red)',
                      pt: 'we fell in love in october (girl in red)',
                    },
                  },
                  {
                    id: 'e',
                    text: {
                      en: 'Closer (Tegan and Sara)',
                      pt: 'Closer (Tegan and Sara)',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['b', 'e', 'c', 'd', 'a'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 2000,
              },
              {
                type: 'order',
                prompt: {
                  en: 'Put these moments of sapphic history in order, earliest first',
                  pt: 'Põe estes momentos da história sáfica por ordem, do mais antigo para o mais recente',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'The Daughters of Bilitis are founded',
                      pt: 'Nascem as Daughters of Bilitis',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'The Lesbian Avengers form in New York',
                      pt: 'Formam-se as Lesbian Avengers em Nova Iorque',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Anne Lister and Ann Walker take communion together in York',
                      pt: 'Anne Lister e Ann Walker comungam juntas em York',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Audre Lorde publishes Zami',
                      pt: 'Audre Lorde publica Zami',
                    },
                  },
                  {
                    id: 'e',
                    text: {
                      en: 'The Well of Loneliness goes on trial for obscenity',
                      pt: 'The Well of Loneliness é julgado por obscenidade',
                    },
                  },
                ],
                answer: {
                  orderedIds: ['c', 'e', 'a', 'd', 'b'],
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: 30,
                points: 2000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'In which year did The L Word first air on Showtime?',
                  pt: 'Em que ano estreou The L Word na Showtime?',
                },
                options: [],
                answer: {
                  value: 2004,
                },
                acceptedAnswers: [],
                mediaRef: null,
                timeLimitSeconds: null,
                points: 1000,
              },
              {
                type: 'closest_number',
                prompt: {
                  en: 'How many Wimbledon singles titles did Martina Navratilova win?',
                  pt: 'Quantos títulos de singulares em Wimbledon ganhou Martina Navratilova?',
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
                type: 'multiple_choice',
                prompt: {
                  en: 'Amélie Mauresmo won both of her Grand Slam singles titles in 2006. Which two?',
                  pt: 'Amélie Mauresmo ganhou os seus dois títulos de singulares do Grand Slam em 2006. Quais?',
                },
                options: [
                  {
                    id: 'a',
                    text: {
                      en: 'Roland-Garros and US Open',
                      pt: 'Roland-Garros e US Open',
                    },
                  },
                  {
                    id: 'b',
                    text: {
                      en: 'Roland-Garros and Wimbledon',
                      pt: 'Roland-Garros e Wimbledon',
                    },
                  },
                  {
                    id: 'c',
                    text: {
                      en: 'Australian Open and Wimbledon',
                      pt: 'Open da Austrália e Wimbledon',
                    },
                  },
                  {
                    id: 'd',
                    text: {
                      en: 'Australian Open and US Open',
                      pt: 'Open da Austrália e US Open',
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
            ],
          },
          {
            kind: 'lie_detector',
            title: {
              en: 'Sapphic Lie Detector',
              pt: 'Detetor sáfico',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Before the 1973 Battle of the Sexes, Bobby Riggs gave Billie Jean King a giant lollipop. What did she give him back?',
                  pt: 'Antes da Batalha dos Sexos de 1973, Bobby Riggs ofereceu a Billie Jean King um chupa-chupa gigante. O que lhe deu ela em troca?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'A piglet',
                    pt: 'Um porquinho',
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
                  en: 'In 1992 the Lesbian Avengers in New York picked up a signature skill for their protests. What was it?',
                  pt: 'Em 1992, as Lesbian Avengers de Nova Iorque adotaram uma habilidade de marca para os protestos. Qual era?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Eating fire',
                    pt: 'Engolir fogo',
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
                  en: 'In 1988 lesbian activists abseiled into the House of Lords to protest Section 28. What did they abseil down?',
                  pt: 'Em 1988, ativistas lésbicas desceram em rapel para a Câmara dos Lordes em protesto contra a Secção 28. O que usaram para descer?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'A washing line',
                    pt: 'Uma corda de estender a roupa',
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
                  en: 'In 2018 York unveiled a rainbow plaque to Anne Lister and then had to reword it. What did the first version call her?',
                  pt: 'Em 2018, York inaugurou uma placa arco-íris a Anne Lister e depois teve de a reescrever. O que lhe chamava a primeira versão?',
                },
                options: [],
                answer: {
                  truth: {
                    en: 'Gender-nonconforming entrepreneur',
                    pt: 'Empreendedora de género não conforme',
                  },
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
              en: 'Sapphic name game',
              pt: 'Jogo dos nomes sáficos',
            },
            contentLabel: 'none',
            settings: {
              timeLimitSeconds: 20,
              isSpeedBonusOn: true,
              isJokerAllowed: true,
              writeSeconds: 60,
              voteSeconds: 30,
              wheelBonus: 0,
              wheelPick: 'round',
              sliceCount: null,
            },
            questions: [
              {
                type: 'prompt',
                prompt: {
                  en: 'Your drag king name is the last thing you fixed with a screwdriver plus your favourite crooner, what is it?',
                  pt: 'O teu nome de drag king é a última coisa que arranjaste com uma chave de fendas mais o teu cantor romântico favorito, qual é?',
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
                  en: 'Name the sapphic indie band headlining tonight and their debut album',
                  pt: 'Dá nome à banda indie sáfica que é cabeça de cartaz hoje à noite e ao seu álbum de estreia',
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
                  en: "Second date and you're already booking the U-Haul. Name the cocktail on tonight's menu that celebrates it",
                  pt: 'Segundo encontro e já estão a alugar a carrinha das mudanças. Dá nome ao cocktail do menu desta noite que celebra isso',
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
  ];
