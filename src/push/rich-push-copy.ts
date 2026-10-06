import type { PushPayload } from './push.service';

/**
 * The Portuguese rich-push copy (PRD-325), for a member whose
 * `member_preferences.language` is `pt` and who shows lock-screen previews.
 *
 * Why the backend renders it: iOS never runs the service worker, so it prints
 * the plain `title`/`body` exactly as sent. Those were always English, which
 * left a Portuguese member's iPhone reading "Mariana accepted your connection
 * request." The service worker on every other engine still localises from the
 * `l10n` keys, which stay in the payload untouched.
 *
 * LOCKSTEP with the `pt` table in `queerpulse/src/pushMessages.ts`: every value
 * here must stay word-for-word the frontend's, so one notification reads the
 * same on an iPhone and on Android. The keys are the ones a rich push carries
 * (`PushNotificationListener`, `PushListener`, the event reminders). The
 * generic hidden-preview, test and new-sign-in copy lives in
 * `generic-push-copy.ts` and is left out here.
 */
export const RICH_PUSH_COPY_PT: Readonly<Record<string, string>> = {
  'push:event.reminder.body': 'A começar em breve. Toca para ver os detalhes.',
  'push:event.reminder.actionDetails': 'Detalhes',
  'push:messages.staffTitle': '{name}, de {business}',
  'push:messages.attachment.photo': 'Foto',
  'push:messages.attachment.gif': 'GIF',
  'push:messages.attachment.document': 'Documento',
  'push:messages.attachment.sticker': 'Sticker',
  'push:messages.group.attachment.photo': '{name}: Foto',
  'push:messages.group.attachment.gif': '{name}: GIF',
  'push:messages.group.attachment.document': '{name}: Documento',
  'push:messages.group.attachment.sticker': '{name}: Sticker',
  'push:messages.group.mention.body': '{name} mencionou-te: {preview}',
  'push:messages.group.mention.photo': '{name} mencionou-te: Foto',
  'push:messages.group.mention.gif': '{name} mencionou-te: GIF',
  'push:messages.group.mention.document': '{name} mencionou-te: Documento',
  'push:messages.group.mention.sticker': '{name} mencionou-te: Sticker',
  'push:connection.request.title': 'Novo pedido de conexão',
  'push:connection.request.body': '{name} quer ligar-se a ti.',
  'push:connection.accepted.title': 'Conexão aceite',
  'push:connection.accepted.body': '{name} aceitou o teu pedido de conexão.',
  'push:mention.title': 'Foste mencionado',
  'push:mention.body': '{name} mencionou-te.',
  'push:forumReply.title': 'Nova resposta',
  'push:forumReply.body': '{name} respondeu-te.',
  'push:forumThreadReviewed.approved.title': 'O teu tópico está publicado',
  'push:forumThreadReviewed.approved.body': '{title} já está no fórum.',
  'push:forumThreadReviewed.rejected.title': 'Sobre o teu tópico',
  'push:forumThreadReviewed.rejected.body':
    '{title} não foi publicado. Toca para leres porquê.',
  'push:vouch.received.title': 'Recebeste um aval',
  'push:vouch.received.body': '{name} avalizou-te.',
  'push:event.updated.title': 'Convívio atualizado',
  'push:event.updated.body':
    '{event} tem novos detalhes. Toca para ver o que mudou.',
  'push:event.cancelled.title': 'Convívio cancelado',
  'push:event.cancelled.body': '{event} foi cancelado.',
  'push:event.cancelled.seriesBodyOne':
    '{event} foi cancelado, e a data seguinte também.',
  'push:event.cancelled.seriesBody':
    '{event} foi cancelado, e mais {count} datas seguintes também.',
  'push:safeSpace.vouch.title': 'Novo aval para o teu espaço seguro',
  'push:safeSpace.vouch.body': '{name} avalizou {space}.',
  'push:housing.match.title': 'Uma casa corresponde à tua procura',
  'push:housing.match.body':
    '{title} em {area} corresponde a uma procura que guardaste.',
  'push:housing.match.bodyNoArea':
    '{title} corresponde a uma procura que guardaste.',
  'push:topic.newPost.title': 'Nova publicação num tópico que segues',
  'push:topic.newPost.body': '{name} publicou em #{topic}.',
  'push:personaUpdate.title': 'Novidades de uma persona que segues',
  'push:personaUpdate.body': '{persona} publicou algo novo.',
  'push:personaUpdate.bodyWithTitle': '{persona} publicou {itemTitle}.',
  'push:housing.decision.approved.title': 'A tua casa está publicada',
  'push:housing.decision.approved.body':
    '{title} já está no quadro de alojamento.',
  'push:housing.decision.changesRequested.title':
    'O teu anúncio precisa de uma alteração',
  'push:housing.decision.changesRequested.body':
    'A moderação pediu uma alteração a {title}. Abre para veres qual.',
  'push:housing.decision.rejected.title': 'O teu anúncio não foi publicado',
  'push:housing.decision.rejected.body':
    '{title} não foi publicado. Abre para veres porquê.',
  'push:housing.decision.takenDown.title': 'O teu anúncio foi retirado',
  'push:housing.decision.takenDown.body':
    '{title} foi retirado do quadro de alojamento. Abre para veres porquê.',
  'push:readingGroupProposal.approved.title':
    'O teu grupo de leitura está criado',
  'push:readingGroupProposal.approved.body':
    '{book} já tem espaço próprio, e é teu.',
  'push:readingGroupProposal.declined.title':
    'Sobre a tua proposta de grupo de leitura',
  'push:readingGroupProposal.declined.body':
    'Não conseguimos avançar com {book}. Toca para leres porquê.',
  'push:groupListing.live.title': 'O teu anúncio está publicado',
  'push:groupListing.live.body': '{title} já está no quadro do grupo.',
  'push:groupListing.question.title': 'Uma questão sobre o teu anúncio',
  'push:groupListing.question.body':
    'A moderação precisa de esclarecer uma coisa sobre {title}.',
  'push:groupListing.hidden.title': 'Sobre o teu anúncio',
  'push:groupListing.hidden.body':
    '{title} foi retirado do quadro do grupo. Toca para leres porquê.',
  'push:groupListing.declined.title': 'Sobre o teu anúncio',
  'push:groupListing.declined.body':
    '{title} não foi publicado. Toca para leres porquê.',
  'push:landlordSuggestion.live.title':
    'A tua sugestão de senhorio está publicada',
  'push:landlordSuggestion.live.body': '{name} já está no diretório. Obrigada.',
  'push:landlordSuggestion.notLive.title': 'Sobre a tua sugestão de senhorio',
  'push:landlordSuggestion.notLive.body':
    '{name} não entrou no diretório. Toca para leres porquê.',
  'push:landlordIntro.accepted.title': 'A tua apresentação está a ser feita',
  'push:landlordIntro.accepted.body':
    'Alguém vai pôr-te em contacto com {name}.',
  'push:landlordIntro.declined.title': 'Sobre o teu pedido de apresentação',
  'push:landlordIntro.declined.body':
    'Não conseguimos fazer a apresentação a {name}. Toca para leres porquê.',
  'push:venue.attachment.title': 'Um convívio no teu espaço',
  'push:venue.attachment.body':
    '{listingName} foi indicado como o espaço de "{eventTitle}".',
  'push:community.supportOffered.title': 'Uma oferta de apoio',
  'push:community.supportOffered.body':
    'Alguém da QueerPulse ofereceu ajuda a {communityName}. Toca para leres.',
  'push:groupAdded.title': 'Adicionaram-te a um grupo',
  'push:groupAdded.body': '{name} adicionou-te a {group}.',
  'push:groupAdded.bodyUntitled': '{name} adicionou-te a um grupo.',
  'push:groupInvite.title': 'Novo convite de grupo',
  'push:groupInvite.body': '{name} convidou-te para {group}.',
  'push:groupInvite.bodyUntitled': '{name} convidou-te para um grupo.',
  'push:listingOwnerOffer.title': 'Oferta de propriedade',
  'push:listingOwnerOffer.body':
    '{name} ofereceu-te a propriedade de {listingName}.',
  'push:goTogether.pairInvite.title': 'Vamos juntes',
  'push:goTogether.pairInvite.body': '{name} quer ir contigo a um convívio',
  'push:goTogether.groupReady.title': 'Vamos juntes',
  'push:goTogether.groupReady.body': 'O teu grupo para um convívio está pronto',
  'push:goTogether.mutual.title': 'Vamos juntes',
  'push:goTogether.mutual.body': 'Tu e {name} querem voltar a encontrar-se',
  'push:goTogether.memberLeft.title': 'Vamos juntes',
  'push:goTogether.memberLeft.body':
    'Alguém saiu do teu grupo para um convívio',
  'push:goTogether.memberLeft.bodyMergeOffer':
    'Alguém saiu do teu grupo. Há outro grupo com lugar para ti',
  'push:goTogether.unmatched.title': 'Vamos juntes',
  'push:goTogether.unmatched.body':
    'Ainda não encontrámos um grupo para ti. Vamos continuar a procurar',
  'push:goTogether.unmatched.bodyFinal':
    'Desta vez não foi possível juntar-te a um grupo',
  'push:goTogether.unmatched.bodyHostSwitchedOff':
    'Quem organiza desligou o Vamos juntes neste convívio',
  'push:goTogether.meetAgain.title': 'Vamos juntes',
  'push:goTogether.meetAgain.body': 'Queres voltar a encontrar o teu grupo?',
};

/** Mirrors `formatPushCopy`'s `{token}` interpolation in `pushMessages.ts`. */
const INTERPOLATION = /\{(\w+)\}/g;

/** A `{token}` still unresolved after interpolation. */
const UNRESOLVED_TOKEN = /\{\w+\}/;

/** Replace `{token}` placeholders; an unknown token is left as it is. */
function interpolate(
  template: string,
  params: Record<string, string> | undefined,
): string {
  if (!params) return template;
  return template.replace(INTERPOLATION, (match, token: string) => {
    const value = params[token];
    return value === undefined ? match : value;
  });
}

/**
 * The rich payload with its plain `title`, `body` and action labels rendered
 * from `catalog`, by the same rules the service worker's `formatPushCopy` and
 * `formatPushActions` apply: a field whose key is absent or unknown keeps its
 * English text, and a title that still holds an unresolved `{token}` keeps
 * the English title. Every other field, `l10n` included, travels unchanged.
 */
export function localizeRichPayload(
  payload: PushPayload,
  catalog: Readonly<Record<string, string>>,
): PushPayload {
  const titleKey = payload.l10n?.titleKey;
  const bodyKey = payload.l10n?.bodyKey;
  const params = payload.l10n?.params;

  const titleTemplate = titleKey !== undefined ? catalog[titleKey] : undefined;
  const bodyTemplate = bodyKey !== undefined ? catalog[bodyKey] : undefined;
  const interpolatedTitle =
    titleTemplate !== undefined
      ? interpolate(titleTemplate, params)
      : undefined;

  return {
    ...payload,
    title:
      interpolatedTitle !== undefined &&
      !UNRESOLVED_TOKEN.test(interpolatedTitle)
        ? interpolatedTitle
        : payload.title,
    body:
      bodyTemplate !== undefined
        ? interpolate(bodyTemplate, params)
        : payload.body,
    ...(payload.actions
      ? {
          actions: payload.actions.map((action) => {
            const localizedTitle =
              action.titleKey !== undefined
                ? catalog[action.titleKey]
                : undefined;
            return localizedTitle !== undefined
              ? { ...action, title: localizedTitle }
              : action;
          }),
        }
      : {}),
  };
}

/**
 * True when `localized` renders exactly what `original` does: same title,
 * same body, same action labels. A DM whose title is a name and whose body
 * is the message text has no key to translate, so its Portuguese payload is
 * the English one and the two recipient groups can share one send.
 */
export function rendersIdentically(
  original: PushPayload,
  localized: PushPayload,
): boolean {
  return (
    original.title === localized.title &&
    original.body === localized.body &&
    (original.actions ?? []).every(
      (action, index) => action.title === localized.actions?.[index]?.title,
    )
  );
}
