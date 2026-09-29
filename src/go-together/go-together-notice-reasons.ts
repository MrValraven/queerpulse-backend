/** Why a member's waiting entry closed without a group, carried on the
 *  `go_together_unmatched` payload so the notice can say so. Kept in a file
 *  of its own so the push listener reads it without loading the host
 *  service. */
export const HOST_SWITCHED_OFF_REASON = 'hostSwitchedOff';
