import { useState, type ReactNode } from 'react'

import { queuedText, type Turn } from '#/routes/-chat/select-turns'
import { marginClass, WorkMargin, WorkToggle } from '#/routes/-chat/work-log'
import { WriteSummaryView } from '#/routes/-chat/write-summary'
import type { QueuedMessage } from '@tanstack/ai-react'

/** What the server says when a run ends early, as the Owner reads it. */
const runEndings = new Map([
  ['Run stopped', 'Detuviste la respuesta.'],
  ['Run timed out', 'La respuesta tardó demasiado. Intenta de nuevo.'],
  ['The run failed', 'No pude terminar la respuesta. Intenta de nuevo.'],
])

/**
 * The adapter reports a refused request only as `HTTP error! status: 409 …`,
 * body discarded, so the status is all there is to word it from.
 */
function describeChatError(error: Error) {
  const ending = runEndings.get(error.message)
  if (ending) return ending
  const status = /^HTTP error! status: (\d+)/.exec(error.message)?.[1]
  if (status === '409')
    return 'Todavía estoy terminando la respuesta anterior. Intenta en un momento.'
  if (status === '429') return 'Llegaste al límite de uso.'
  if (status === '401' || status === '403')
    return 'Tu sesión expiró. Recarga la página.'
  return 'Algo salió mal. Intenta de nuevo.'
}

/**
 * One line of the conversation: the 816px column centered on the screen,
 * with the right margin free for notes, so showing work never moves the text.
 */
export function Row({
  children,
  margin,
  className = '',
}: {
  children: ReactNode
  margin?: ReactNode
  className?: string
}) {
  return (
    <div className={`grid grid-cols-[1fr_min(816px,100%)_1fr] ${className}`}>
      <div className="col-start-2 flex min-w-0 flex-col px-11">{children}</div>
      {margin && (
        <aside className={`col-start-3 min-w-0 max-w-[320px] pr-6 pt-2 ${marginClass}`}>
          {margin}
        </aside>
      )}
    </div>
  )
}

export function Caret() {
  return (
    <span className="ml-[3px] inline-block h-[17px] w-[9px] translate-y-[2px] bg-ink" />
  )
}

export function UserTurn({ turn }: { turn: Extract<Turn, { kind: 'user' }> }) {
  return (
    <Row>
      <div className="max-w-[74%] self-end whitespace-pre-wrap text-right text-ink-dim">
        {turn.text}
      </div>
    </Row>
  )
}

export function AssistantTurn({
  turn,
}: {
  turn: Extract<Turn, { kind: 'assistant' }>
}) {
  // Whether this turn's calls are unfolded under the reply, on screens without a margin.
  const [workOpen, setWorkOpen] = useState(false)

  return (
    <Row margin={turn.work.length > 0 && <WorkMargin calls={turn.work} />}>
      <div className="flex flex-col gap-[18px]">
        {turn.thinking !== null && (
          <div className="max-w-[86%] whitespace-pre-wrap font-read text-ink-faint">
            {turn.thinking}
          </div>
        )}
        {(turn.text || turn.streaming) && (
          <div className="max-w-[86%] whitespace-pre-wrap">
            {turn.text}
            {turn.streaming && <Caret />}
          </div>
        )}
        <WriteSummaryView summary={turn.summary} />
        {turn.work.length > 0 && (
          <WorkToggle
            calls={turn.work}
            onToggle={() => setWorkOpen((open) => !open)}
            open={workOpen}
          />
        )}
      </div>
    </Row>
  )
}

export function QueuedTurn({
  queued,
  onCancel,
}: {
  queued: QueuedMessage
  onCancel: () => void
}) {
  return (
    <Row>
      <div className="flex max-w-[74%] flex-col items-end gap-1 self-end text-right">
        <div className="whitespace-pre-wrap text-ink-faint">
          {queuedText(queued)}
        </div>
        <button
          className="cursor-pointer font-meta text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
          onClick={onCancel}
          type="button"
        >
          en cola · cancelar
        </button>
      </div>
    </Row>
  )
}

export function ErrorTurn({ error }: { error: Error }) {
  return (
    <Row>
      <div className="max-w-[86%] border-t border-rule-strong pt-[18px] text-ink">
        {describeChatError(error)}
      </div>
    </Row>
  )
}
