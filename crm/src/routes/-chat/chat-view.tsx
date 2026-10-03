import { useEffect, useRef, useState } from 'react'

import { PaperPicker } from '#/components/paper-picker'
import type { WorkCall } from '#/lib/write-receipts'
import { Composer } from '#/routes/-chat/composer'
import { EmptyState } from '#/routes/-chat/empty-state'
import { selectTurns } from '#/routes/-chat/select-turns'
import {
  AssistantTurn,
  Caret,
  ErrorTurn,
  QueuedTurn,
  Row,
  UserTurn,
} from '#/routes/-chat/turns'
import type { QueuedMessage, UIMessage } from '@tanstack/ai-react'

/**
 * The chat screen with no transport: everything it shows arrives as props, so
 * the app route feeds it from useChat and the design preview from fixtures.
 */

export const workStorageKey = 'chat-work'

function readStored(key: string) {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* private mode: the toggle still works for this session */
  }
}

/** Within this many pixels of the bottom counts as following the conversation. */
const pinnedSlackPx = 40

function isPinned(element: HTMLElement) {
  return (
    element.scrollHeight - element.scrollTop - element.clientHeight <
    pinnedSlackPx
  )
}

export type ChatViewProps = {
  messages: Array<UIMessage>
  /** Live per-call records, keyed by the code-mode tool call that made them. */
  callsByToolCall: Map<string, Array<WorkCall>>
  isLoading: boolean
  error: Error | undefined
  queue: ReadonlyArray<QueuedMessage>
  /** A degraded-connection note for the header, or null when all is well. */
  connectionLabel: string | null
  input: string
  onInputChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
  onCancelQueued: (id: string) => void
  /** The Owner's name for the empty-state greeting, when known. */
  ownerName?: string
}

export function ChatView({
  messages,
  callsByToolCall,
  isLoading,
  error,
  queue,
  connectionLabel,
  input,
  onInputChange,
  onSubmit,
  onStop,
  onCancelQueued,
  ownerName,
}: ChatViewProps) {
  const [showWork, setShowWork] = useState(import.meta.env.DEV)
  const messageEnd = useRef<HTMLDivElement>(null)
  const inputField = useRef<HTMLTextAreaElement>(null)
  // Starts pinned, so the first paint of a stored transcript lands on its end.
  const messagesPinned = useRef(true)

  useEffect(() => {
    const storedWork = readStored(workStorageKey)
    if (storedWork === 'on' || storedWork === 'off')
      setShowWork(storedWork === 'on')
  }, [])

  // Follow new content only while the reader is at the bottom; scrolling up
  // to reread unpins until they come back down.
  useEffect(() => {
    if (messagesPinned.current) messageEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages, callsByToolCall, queue.length, error, isLoading])

  function toggleWork() {
    const next = !showWork
    setShowWork(next)
    writeStored(workStorageKey, next ? 'on' : 'off')
  }

  function submit() {
    // Sending is a return to the conversation's end.
    messagesPinned.current = true
    onSubmit()
  }

  const isEmpty =
    messages.length === 0 && !isLoading && queue.length === 0 && !error

  function pickPrompt(prompt: string) {
    onInputChange(prompt)
    inputField.current?.focus()
  }

  const { turns, waiting } = selectTurns(
    messages,
    callsByToolCall,
    isLoading,
    showWork,
  )

  const dateLabel = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(new Date())
    .replace(',', '')

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-ground text-ink">
      <header className="flex items-baseline justify-between border-b border-rule px-11 pb-[18px] pt-6 font-meta text-[10px] uppercase tracking-[0.16em] text-ink-mute">
        <span className="flex gap-6">
          <span>{dateLabel}</span>
          {connectionLabel && <span>{connectionLabel}</span>}
        </span>
        <span className="flex gap-6">
          <button
            className="cursor-pointer uppercase tracking-[0.16em] hover:text-ink"
            onClick={toggleWork}
            type="button"
          >
            {showWork ? 'ocultar trabajo' : 'ver trabajo'}
          </button>
        </span>
      </header>

      <div
        className="flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto pt-[30px] font-read text-[19px] font-light leading-[1.6]"
        onScroll={(event) => {
          messagesPinned.current = isPinned(event.currentTarget)
        }}
      >
        {isEmpty && (
          <Row className="mt-auto">
            <EmptyState onPick={pickPrompt} ownerName={ownerName} />
          </Row>
        )}

        {turns.map((turn) => {
          switch (turn.kind) {
            case 'user':
              return <UserTurn key={turn.id} turn={turn} />
            case 'assistant':
              return <AssistantTurn key={turn.id} turn={turn} />
          }
        })}

        {waiting && (
          <Row>
            <div className="max-w-[86%]">
              <Caret />
            </div>
          </Row>
        )}

        {queue.map((queued) => (
          <QueuedTurn
            key={queued.id}
            onCancel={() => onCancelQueued(queued.id)}
            queued={queued}
          />
        ))}

        {error && <ErrorTurn error={error} />}

        <div className="h-[6px] shrink-0" ref={messageEnd} />
      </div>

      <PaperPicker />

      <Composer
        ref={inputField}
        input={input}
        isLoading={isLoading}
        onInputChange={onInputChange}
        onStop={onStop}
        onSubmit={submit}
      />
    </main>
  )
}
