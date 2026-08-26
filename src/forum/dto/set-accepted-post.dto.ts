import { IsOptional, IsUUID } from 'class-validator';

/**
 * `POST /forum/threads/:slug/accepted-answer` body (SOC-13).
 *
 * `postId` names the reply to mark as the thread's answer. Omitting it (or
 * sending `null`) CLEARS the mark — one route for both directions, so the
 * frontend's single toggle does not have to pick between two endpoints and a
 * moderator un-accepting is the same authorization check as accepting.
 */
export class SetAcceptedPostDto {
  @IsOptional()
  @IsUUID()
  postId?: string | null;
}
