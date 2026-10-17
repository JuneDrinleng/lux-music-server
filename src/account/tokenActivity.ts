import { getAccountStore } from './store'

/** Append a short outcome, never request bodies or song lists. Also used by MCP. */
export const recordTokenActivity = (tokenId: string, action: string, summary: string, ok: boolean) => {
  getAccountStore().pats.recordActivity(tokenId, { at: Date.now(), action: action.slice(0, 80), summary: summary.slice(0, 160), ok })
}
