/**
 * The test window before its first message, laid out as the reference
 * implementation's yinglong page lays its welcome: a greeting over the
 * agent's description, a grid with one cell per skill (a cell sends the
 * first eval-case message that expects its skill, and is greyed out when no
 * case does), and the first messages of the agent's first three eval cases.
 * Nothing here is written for one agent: the words come from its
 * description, its skills, and its cases.
 * @module @lyteboat/studio-web/client/studio-chat-welcome
 */

import type { StudioChatWelcome } from './studio-chat-messages.ts'
import { ChevronRightIcon, SparkIcon } from './studio-icons.tsx'

/** The welcome; `onSend` sends a prompt as the editor's message. */
export function StudioChatWelcomeView({ description, welcome, onSend }: { description: string | undefined; welcome: StudioChatWelcome; onSend(message: string): void }) {
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-title">Hi~ 有什么可以帮您</div>
      {description !== undefined && description !== '' && <div className="chat-welcome-sub"><span aria-hidden="true">◆</span> {description}</div>}
      {welcome.skills.length > 0 && (
        <div className="chat-quick-card">
          <div className="chat-quick-card-title">猜你想要</div>
          <div className="chat-quick-grid">
            {welcome.skills.map(({ skill, message }, index) => (
              <button
                className="chat-quick-item"
                disabled={message === undefined}
                key={skill}
                onClick={() => { if (message !== undefined) onSend(message) }}
                title={message ?? '没有评测用例期望这个技能'}
                type="button"
              >
                <span className={`chat-quick-icon chat-quick-icon-${String(index % 4)}`}><SparkIcon /></span>
                <span className="chat-quick-label">{skill}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {welcome.questions.length > 0 && (
        <div className="chat-quick-links">
          {welcome.questions.map(question => (
            <button className="chat-quick-link" key={question} onClick={() => onSend(question)} type="button">
              <span className="chat-quick-link-text">{question}</span>
              <ChevronRightIcon />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
