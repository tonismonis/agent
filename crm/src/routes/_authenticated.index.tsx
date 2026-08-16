import { createFileRoute } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getDailyThreadId,
  millisecondsUntilThreadRotation,
} from '#/lib/chat-thread'
import {
  inferWriteCallsFromCode,
  summarizeWrites,
  type WorkCall,
  type WriteSummary,
} from '#/lib/write-receipts'
import type { UIMessage } from '@tanstack/ai-react'

type ToolCallPart = Extract<UIMessage['parts'][number], { type: 'tool-call' }>

type Theme = 'dark' | 'light'

const themeStorageKey = 'chat-theme'
const workStorageKey = 'chat-work'

export const Route = createFileRoute('/_authenticated/')({ component: Home })

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

function formatValue(value: unknown) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function getTypeScript(argumentsText: string) {
  try {
    const input = JSON.parse(argumentsText) as { typescriptCode?: unknown }
    return typeof input.typescriptCode === 'string'
      ? input.typescriptCode
      : argumentsText
  } catch {
    return argumentsText
  }
}

/** `client_id=8 · limit=10` — the call's inputs on one line. */
function formatArgs(args: unknown) {
  if (args === undefined || args === null) return ''
  if (typeof args !== 'object' || Array.isArray(args))
    return truncate(formatValue(args), 90)
  const entries = Object.entries(args as Record<string, unknown>)
  if (entries.length === 0) return ''
  return truncate(
    entries
      .map(([key, value]) => {
        const text =
          typeof value === 'string' ? value : formatValue(value).replace(/\s+/g, ' ')
        return `${key}=${truncate(text, 28)}`
      })
      .join(' · '),
    140,
  )
}

function textOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('')
}

function toolCallPartsOf(message: UIMessage) {
  return message.parts.filter(
    (part): part is ToolCallPart => part.type === 'tool-call',
  )
}

/**
 * The calls one turn made. Live calls arrive as code-mode events; a turn
 * replayed from persistence has none, so the code it ran is read back instead.
 */
function callsForMessage(
  message: UIMessage,
  callsByToolCall: Map<string, Array<WorkCall>>,
): Array<WorkCall> {
  return toolCallPartsOf(message).flatMap((part) => {
    const live = callsByToolCall.get(part.id)
    if (live && live.length > 0) return live
    return inferWriteCallsFromCode(getTypeScript(part.arguments), part.id)
  })
}

function WorkBlock({ call }: { call: WorkCall }) {
  const args = formatArgs(call.args)
  const output = call.error ?? (call.result === undefined ? '' : formatValue(call.result))

  return (
    <div className="flex flex-col gap-1 border-t border-rule pt-4">
      <div className="flex justify-between gap-3 text-ink-dim">
        <span className="break-all">{call.name}</span>
        {call.durationMs !== undefined && (
          <span className="shrink-0 text-ink-faint">{call.durationMs} ms</span>
        )}
      </div>
      {args && <div>{args}</div>}
      {output && (
        <pre className="m-0 whitespace-pre-wrap break-words font-meta text-[10px] leading-[1.55] text-ink-faint">
          {truncate(output, 600)}
        </pre>
      )}
    </div>
  )
}

/** Under the threshold: the fields that moved, under a 2px rule. */
function WriteReceipt({
  receipt,
}: {
  receipt: Extract<WriteSummary, { kind: 'receipt' }>
}) {
  return (
    <div className="flex max-w-[86%] flex-col gap-[9px] border-l-2 border-ink py-[2px] pl-4 font-meta text-[11.5px] leading-[1.5]">
      <div className="text-[9.5px] uppercase tracking-[0.18em] text-ink-mute">
        Written
      </div>
      {receipt.lines.map((line) => (
        <div className="flex justify-between gap-5" key={`${line.label}-${line.value}`}>
          <span>{line.label}</span>
          <span className="text-right text-ink-dim">{line.value}</span>
        </div>
      ))}
    </div>
  )
}

/** At or above the threshold: the record as it now reads. */
function RecordCard({
  card,
}: {
  card: Extract<WriteSummary, { kind: 'card' }>
}) {
  return (
    <div className="flex max-w-[86%] flex-col gap-3 border border-rule-strong px-[18px] py-4">
      <div className="flex items-baseline justify-between gap-5 font-meta text-[9.5px] uppercase tracking-[0.18em] text-ink-mute">
        <span>{card.subject}</span>
        <span className="shrink-0 text-right">
          {card.count} {card.count === 1 ? 'record' : 'records'} written
        </span>
      </div>
      <div className="flex flex-col gap-[2px] font-meta text-[12px] leading-[1.7] text-ink-2">
        {card.rows.map((row) => (
          <div className="flex justify-between gap-5" key={row.label}>
            <span className="text-ink-mute">{row.label}</span>
            <span className="text-right">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function WriteSummaryView({ summary }: { summary: WriteSummary }) {
  if (summary.kind === 'card') return <RecordCard card={summary} />
  if (summary.kind === 'receipt') return <WriteReceipt receipt={summary} />
  return null
}

function Caret() {
  return (
    <span className="ml-[3px] inline-block h-[17px] w-[9px] translate-y-[2px] bg-ink" />
  )
}

function Home() {
  const [input, setInput] = useState('')
  const [threadId, setThreadId] = useState(() => getDailyThreadId())
  const [theme, setTheme] = useState<Theme>('dark')
  const [showWork, setShowWork] = useState(import.meta.env.DEV)
  const [callsByToolCall, setCallsByToolCall] = useState<
    Map<string, Array<WorkCall>>
  >(new Map())
  const callKey = useRef(0)
  const messageScroll = useRef<HTMLDivElement>(null)
  const messageEnd = useRef<HTMLDivElement>(null)
  const workScroll = useRef<HTMLDivElement>(null)
  const workEnd = useRef<HTMLDivElement>(null)

  // The document already carries the stored theme (an inline script in the root
  // applies it before paint); this only catches the control's label up.
  useEffect(() => {
    const stored = readStored(themeStorageKey)
    if (stored === 'light' || stored === 'dark') setTheme(stored)
    const storedWork = readStored(workStorageKey)
    if (storedWork === 'on' || storedWork === 'off')
      setShowWork(storedWork === 'on')
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setThreadId(getDailyThreadId())
    }, millisecondsUntilThreadRotation())
    return () => window.clearTimeout(timeout)
  }, [threadId])

  function toggleTheme() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.dataset.theme = next
    writeStored(themeStorageKey, next)
  }

  function toggleWork() {
    const next = !showWork
    setShowWork(next)
    writeStored(workStorageKey, next ? 'on' : 'off')
  }

  const scrollIfPinned = useCallback(
    (container: HTMLElement | null, anchor: HTMLDivElement | null) => {
      if (
        !container ||
        container.scrollHeight - container.scrollTop - container.clientHeight >=
          40
      ) {
        return
      }

      requestAnimationFrame(() => anchor?.scrollIntoView({ block: 'end' }))
    },
    [],
  )

  const scrollMessages = useCallback(() => {
    scrollIfPinned(messageScroll.current, messageEnd.current)
  }, [scrollIfPinned])

  const scrollWork = useCallback(() => {
    scrollIfPinned(workScroll.current, workEnd.current)
  }, [scrollIfPinned])

  const onCustomEvent = useCallback(
    (type: string, data: unknown, context: { toolCallId?: string }) => {
      const toolCallId = context.toolCallId
      if (!toolCallId || !type.startsWith('code_mode:')) return
      const payload = (data ?? {}) as Record<string, unknown>
      const name = typeof payload.function === 'string' ? payload.function : null
      const duration =
        typeof payload.duration === 'number'
          ? payload.duration
          : typeof payload.durationMs === 'number'
            ? payload.durationMs
            : undefined

      setCallsByToolCall((current) => {
        const calls = [...(current.get(toolCallId) ?? [])]

        if (type === 'code_mode:external_call' && name) {
          calls.push({
            key: `${toolCallId}:${callKey.current++}`,
            toolCallId,
            name,
            args: payload.args,
          })
        } else if (
          (type === 'code_mode:external_result' ||
            type === 'code_mode:external_error') &&
          name
        ) {
          // Pair the result with the most recent unfinished call of that name.
          const index = calls.findLastIndex(
            (call) =>
              call.name === name &&
              call.result === undefined &&
              call.error === undefined,
          )
          if (index === -1) return current
          calls[index] = {
            ...calls[index]!,
            durationMs: duration,
            ...(type === 'code_mode:external_result'
              ? { result: payload.result ?? null }
              : { error: formatValue(payload.error) }),
          }
        } else if (
          type === 'code_mode:execution_finished' &&
          payload.success === false
        ) {
          const error = payload.error as { message?: unknown } | undefined
          calls.push({
            key: `${toolCallId}:${callKey.current++}`,
            toolCallId,
            name: 'execute_typescript',
            durationMs: duration,
            error:
              typeof error?.message === 'string'
                ? error.message
                : 'execution failed',
          })
        } else {
          return current
        }

        const next = new Map(current)
        next.set(toolCallId, calls)
        return next
      })
      scrollWork()
    },
    [scrollWork],
  )

  const { messages, sendMessage, isLoading, error } = useChat({
    threadId,
    connection: fetchServerSentEvents('/api/chat'),
    persistence: true,
    onChunk: (chunk) => {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') scrollMessages()
      if (chunk.type.startsWith('TOOL_CALL_')) scrollWork()
    },
    onCustomEvent,
  })

  const workCalls = messages.flatMap((message) =>
    toolCallPartsOf(message).flatMap(
      (part) => callsByToolCall.get(part.id) ?? [],
    ),
  )

  const lastAssistantId = messages.findLast(
    (message) => message.role === 'assistant',
  )?.id
  const streamingOnLastAssistant =
    isLoading && messages.at(-1)?.role === 'assistant'

  async function submit() {
    const message = input.trim()
    if (!message || isLoading) return
    setInput('')
    const sending = sendMessage(message)
    scrollMessages()
    await sending
  }

  const dateLabel = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(new Date())

  const columnWidth = `w-full max-w-[816px] ${showWork ? 'mx-0' : 'mx-auto'}`

  return (
    <div
      className={`grid h-screen overflow-hidden bg-ground text-ink ${
        showWork ? 'grid-cols-[230px_1fr]' : 'grid-cols-1'
      }`}
    >
      {showWork && (
        <aside className="flex min-h-0 flex-col border-r border-rule font-meta">
          <div className="flex items-baseline justify-between px-[18px] pb-4 pt-6 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
            <span>Work</span>
            <span>
              {workCalls.length} {workCalls.length === 1 ? 'call' : 'calls'}
            </span>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[18px] pb-6 text-[10.5px] leading-[1.6] text-ink-mute"
            ref={workScroll}
          >
            {workCalls.length === 0 && (
              <p className="pt-4 text-ink-faint">No calls this session.</p>
            )}
            {workCalls.map((call) => (
              <WorkBlock call={call} key={call.key} />
            ))}
            <div ref={workEnd} />
          </div>
          <div className="flex items-center justify-between border-t border-rule px-[18px] py-3 text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            <span>Dev</span>
            <button
              className="cursor-pointer border-b border-ink-mute pb-[2px] uppercase tracking-[0.14em] hover:text-ink"
              onClick={toggleWork}
              type="button"
            >
              hide
            </button>
          </div>
        </aside>
      )}

      <main className="flex min-h-0 flex-col">
        <header className="flex items-baseline justify-between border-b border-rule px-11 pb-[18px] pt-6 font-meta text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          <span>{dateLabel}</span>
          <span className="flex gap-6">
            <button
              className="cursor-pointer uppercase tracking-[0.16em] hover:text-ink"
              onClick={toggleTheme}
              type="button"
            >
              {theme === 'dark' ? 'light' : 'dark'}
            </button>
            <button
              className="cursor-pointer uppercase tracking-[0.16em] hover:text-ink"
              onClick={toggleWork}
              type="button"
            >
              {showWork ? 'hide work' : 'show work'}
            </button>
          </span>
        </header>

        <div
          className={`flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-11 pt-[30px] font-read text-[19px] font-light leading-[1.6] ${columnWidth}`}
          ref={messageScroll}
        >
          {messages.map((message) => {
            const text = textOf(message)
            const summary =
              message.role === 'assistant'
                ? summarizeWrites(callsForMessage(message, callsByToolCall))
                : ({ kind: 'none' } as WriteSummary)
            const showCaret =
              streamingOnLastAssistant && message.id === lastAssistantId

            if (!text && summary.kind === 'none' && !showCaret) return null

            if (message.role === 'user') {
              return (
                <div
                  className="max-w-[74%] self-end whitespace-pre-wrap text-right text-ink-dim"
                  key={message.id}
                >
                  {text}
                </div>
              )
            }

            return (
              <div className="flex flex-col gap-[18px]" key={message.id}>
                {(text || showCaret) && (
                  <div className="max-w-[86%] whitespace-pre-wrap">
                    {text}
                    {showCaret && <Caret />}
                  </div>
                )}
                <WriteSummaryView summary={summary} />
              </div>
            )
          })}

          {isLoading && !streamingOnLastAssistant && (
            <div className="max-w-[86%]">
              <Caret />
            </div>
          )}

          {error && (
            <div className="max-w-[86%] border-t border-rule-strong pt-[18px] text-ink">
              {error.message}
            </div>
          )}

          <div className="h-[6px] shrink-0" ref={messageEnd} />
        </div>

        <form
          className={`px-11 pb-[30px] pt-[22px] ${columnWidth}`}
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div className="flex items-center gap-5 border border-rule-strong px-[18px] py-[15px]">
            <textarea
              aria-label="Message"
              className="max-h-[40vh] min-h-[27px] flex-1 resize-none bg-transparent font-read text-[18px] font-light leading-[1.5] text-ink outline-none field-sizing-content placeholder:text-ink-ghost disabled:text-ink-mute"
              disabled={isLoading}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="Ask, or say what happened…"
              rows={1}
              value={input}
            />
            <button
              className="shrink-0 cursor-pointer self-center font-meta text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:text-ink-faint"
              disabled={isLoading || !input.trim()}
              type="submit"
            >
              send
            </button>
          </div>
        </form>
      </main>
    </div>
  )
}
