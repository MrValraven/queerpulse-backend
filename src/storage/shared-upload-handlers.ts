/**
 * The ENUMERATED exemption list for `StorageKeyOwnershipInterceptor`'s
 * foreign-upload check.
 *
 * BACKGROUND. A storage key embeds the id of whoever presigned the upload
 * (`<prefix>/<ownerUserId>/<uuid><ext>`), and the interceptor rejects a write
 * body that references a key belonging to somebody else. That rule used to be
 * skipped entirely whenever the value arrived as the resolved
 * `<apiBaseUrl>/files/<key>` URL, on the theory that such a URL is
 * "server-issued" and therefore trusted. It is not: that URL is exactly what
 * every `<img src>` on every page carries, so any member could copy another
 * member's avatar URL out of the DOM and PATCH it onto their own profile
 * (impersonation), and a later replace/clear of that field would delete the
 * victim's object from the bucket. The check now runs on both forms.
 *
 * WHY THIS LIST EXISTS. Some entities are edited by more than one member
 * (a community by any of its moderators, an event by its cohosts, a group
 * chat by its admins, a co-owned persona by its collaborators, the magazine
 * desk by any editor). Their edit forms are seeded with the CURRENTLY STORED
 * image, which a DIFFERENT member may have uploaded, and re-send it verbatim
 * on save. Under a blanket rule that save would 403 even though nothing about
 * the image changed.
 *
 * WHAT THE EXEMPTION ACTUALLY GRANTS. For a handler listed here — and only for
 * a value that arrived in the resolved `/files/<key>` URL form, never a bare
 * key — a foreign key is normalised and passed through instead of rejected.
 * That is the PRE-EXISTING behaviour, preserved narrowly rather than globally,
 * so the fleet-wide impersonation vector (`PATCH /profiles/me` with someone
 * else's avatar, work-item images, listing photos, community posts, DM
 * attachments, …) is closed today.
 *
 * THE INTENDED END STATE, per handler on this list: the SERVICE compares each
 * incoming image value against the entity's currently stored value and allows
 * a foreign key only when it is UNCHANGED, then the handler comes off this
 * list. `SubprofilesService.update`/`replaceSection` already do this (see
 * `assertNoForeignUploadIntroduced`); the rest are follow-ups owned by their
 * own modules.
 *
 * ADDING AN ENTRY IS A SECURITY DECISION. Only a genuinely multi-editor entity
 * belongs here, and only until its service does the unchanged-value check.
 * Entries are `${ControllerClassName}.${handlerMethodName}` — the interceptor
 * reads both off the `ExecutionContext`, so a renamed controller/handler
 * silently falls back to the STRICT rule (fail-closed) rather than to the
 * exemption.
 */
export const SHARED_UPLOAD_HANDLERS: ReadonlySet<string> = new Set([
  // Co-owned personas — paired with the service-side unchanged-value check.
  'SubprofilesController.update',
  'SubprofilesController.replaceSection',
  // Community cover: every owner/moderator edits the same community.
  'CommunitiesController.update',
  // Event cover: cohosts edit the same event.
  'EventsController.update',
  // Group-chat photo: any owner/admin of the group edits the same conversation.
  'ConversationsController.update',
  // Business listing photos: claimed listings have more than one editor.
  'ListingsController.update',
  // Housing listing gallery: co-listers edit the same listing.
  'HousingListingsController.update',
  // Company logo/work images: co-managed company pages.
  'CompaniesController.update',
  // Staff-curated shared libraries — any moderator/admin edits any row, and
  // the images were uploaded by whichever staffer happened to source them.
  'AdminLandlordsController.create',
  'AdminLandlordsController.update',
  'AdminChangemakersController.create',
  'AdminChangemakersController.update',
  'AdminTitlesController.create',
  'AdminTitlesController.update',
  'AdminBotsController.updateBotProfile',
  'AdminBotsController.replaceBotWork',
  // Magazine desk — any `magazine_editor` edits any piece/issue/deck.
  'AdminMagazineIssuesController.updateCover',
  'AdminMagazineDecksController.create',
  'AdminMagazineDecksController.update',
  'AdminMagazinePiecesController.updateArticleDraft',
]);

/**
 * Whether this controller+handler pair keeps the legacy "a resolved
 * `/files/<key>` URL may name a foreign upload" allowance. Unknown pairs are
 * NOT exempt — the strict rule is the default.
 */
export function allowsSharedUploads(
  controllerName: string | undefined,
  handlerName: string | undefined,
): boolean {
  if (!controllerName || !handlerName) {
    return false;
  }
  return SHARED_UPLOAD_HANDLERS.has(`${controllerName}.${handlerName}`);
}
