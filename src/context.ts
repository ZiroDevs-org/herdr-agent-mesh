import type { HerdrCallerContext } from "./herdr-client"
import { HerdrRejectionError, REJECTION_CODE } from "./protocol"

export const HERDR_CONTEXT_ENV = {
  WORKSPACE: "HERDR_WORKSPACE_ID",
  TAB: "HERDR_TAB_ID",
  PANE: "HERDR_PANE_ID",
  SESSION: "HERDR_AGENT_SESSION_ID",
} as const

export function readHerdrCallerContext(env: NodeJS.ProcessEnv = process.env): HerdrCallerContext | undefined {
  const workspaceId = nonEmpty(env[HERDR_CONTEXT_ENV.WORKSPACE])
  const tabId = nonEmpty(env[HERDR_CONTEXT_ENV.TAB])
  const paneId = nonEmpty(env[HERDR_CONTEXT_ENV.PANE])
  const present = [workspaceId, tabId, paneId].filter((value) => value !== undefined).length

  if (present === 0) return undefined
  if (present !== 3) throw new HerdrRejectionError(
    REJECTION_CODE.INVALID_IDENTITY,
    "Herdr caller context is incomplete; provide an explicit scope or run inside Herdr",
  )

  return {
    location: {
      workspace_id: workspaceId!,
      tab_id: tabId!,
      pane_id: paneId!,
    },
    ...(nonEmpty(env[HERDR_CONTEXT_ENV.SESSION]) === undefined
      ? {}
      : { session_id: nonEmpty(env[HERDR_CONTEXT_ENV.SESSION]) }),
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() === "" ? undefined : value?.trim()
}
