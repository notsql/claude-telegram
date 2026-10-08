/**
 * `/settings` → 🤖 Agent (008 FR20, replaces `/agent`): pick what this chat
 * or topic runs as (009 FR3). `agn:m` is the page; `agn:u:<name>` picks an
 * agent and `agn:u:` goes back to the default assistant.
 */

import type { InlineKeyboardButton } from 'grammy/types'
import type { PolicyView } from './policyUi.ts'

export const AGENT_CALLBACK = /^agn:(m|u):([\w.-]{0,58})$/

type Agent = { name: string; description: string }

const button = (text: string, data: string): InlineKeyboardButton => ({ text: text.slice(0, 64), callback_data: data })

export function agentView(current: string | undefined, agents: Agent[]): PolicyView {
  return {
    text: [
      `🤖 Agent: ${current ?? 'Default assistant'}`, '',
      'Who answers here. The default assistant already hands work to these agents when it helps, so most chats keep it. Pick an agent to have every turn here run as it, with its own instructions, tools and model.', '',
      ...agents.filter(a => a.name.length <= 58).map(a => `${a.name === current ? '• ' : ''}${a.name}: ${a.description || '(no description)'}`),
    ].join('\n').slice(0, 4000),
    keyboard: { inline_keyboard: [
      [button(`${current ? '' : '• '}Default assistant`, 'agn:u:')],
      ...agents.filter(a => a.name.length <= 58).map(a => [button(`${a.name === current ? '• ' : ''}${a.name}`, `agn:u:${a.name}`)]),
      [button('« Back', 'pol:m')],
    ] },
  }
}
