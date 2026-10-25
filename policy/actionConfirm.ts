/**
 * `action_confirm` on the daemon MCP server (020 FR2): the agent declares a
 * send / pay / sign / delete step that no tool call shows, such as a Pay
 * click in the browser, and waits for the owner's tap on an action card.
 * Unanswered is a no, as with every approval (constitution IV).
 */

import type { ToolResult } from '../memory/tools.ts'
import type { ActionCard } from './approvals.ts'
import { ACTION_LABEL, type ActionClass } from './consequential.ts'

const CLASSES = Object.keys(ACTION_LABEL) as ActionClass[]

const TOOL = {
  name: 'action_confirm',
  description: 'Ask the owner before a step that sends to other people, pays, signs or deletes, when that step is not itself a tool call the owner gets asked about: for example clicking Pay, Place order, Sign or Delete in a browser. Returns whether they approved. Never take the step without an approval.',
  inputSchema: {
    type: 'object',
    properties: {
      class: { type: 'string', enum: CLASSES },
      summary: { type: 'string', description: 'One line: who or what, and how much, e.g. "Pay S$84.20 to SP Group".' },
      details: { type: 'string', description: 'Everything the owner should check before approving: recipient, amount, items, the text being sent.' },
    },
    required: ['class', 'summary', 'details'],
  },
}

const text = (t: string, isError?: boolean): ToolResult => ({ content: [{ type: 'text', text: t }], ...(isError && { isError }) })

/** `confirm` is the 003 approval prompt (no Always). */
export function createActionConfirm(confirm: (key: string, toolName: string, input: Record<string, unknown>, card?: ActionCard) => Promise<boolean>) {
  return {
    list: () => [TOOL],

    /** Undefined when `name` is not this tool. */
    async call(name: string, args: Record<string, unknown>, key: string): Promise<ToolResult | undefined> {
      if (name !== TOOL.name) return
      const cls = args.class as ActionClass
      if (!CLASSES.includes(cls)) return text(`class must be one of ${CLASSES.join(', ')}.`, true)
      const summary = String(args.summary ?? '').trim().slice(0, 200)
      if (!summary) return text('summary is required.', true)
      const ok = await confirm(key, TOOL.name, { details: String(args.details ?? '') }, { action: cls, summary })
      return text(ok
        ? 'Approved. Take exactly this step, nothing more.'
        : "Not approved. Don't take this step or try another way to do it; tell the owner and ask what they want instead.")
    },
  }
}

export type ActionConfirm = ReturnType<typeof createActionConfirm>
