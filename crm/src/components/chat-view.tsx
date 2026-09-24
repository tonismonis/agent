import { parsePartialJSON } from '@tanstack/ai'
import { useEffect, useRef, useState } from 'react'

import { formatJson, isJsonObject, isJsonString, type JsonValue } from '#/lib/json'
import {
  inferWriteCallsFromCode,
  summarizeWrites,
  type WorkCall,
  type WriteSummary,
} from '#/lib/write-receipts'
import type { QueuedMessage, UIMessage } from '@tanstack/ai-react'

/**
 * The chat screen with no transport: everything it shows arrives as props, so
 * the app route feeds it from useChat and the design preview from fixtures.
 */

type ToolCallPart = Extract<UIMessage['parts'][number], { type: 'tool-call' }>

type Theme = 'dark' | 'light'

const themeStorageKey = 'chat-theme'
const workStorageKey = 'chat-work'

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

function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** The code a call ran: its parsed input once complete, partial JSON while streaming. */
function getTypeScript(part: ToolCallPart) {
  // SAFETY: a tool input is the JSON the model called the tool with.
  const input = (part.input ?? parsePartialJSON(part.arguments)) as JsonValue
  const code = isJsonObject(input) ? input.typescriptCode : undefined
  return isJsonString(code) ? code : part.arguments
}

/** execute_typescript reported failure, so the code's writes are unknown. */
function executionFailed(part: ToolCallPart) {
  // SAFETY: the tool's output is the JSON its server handler returned.
  const output = part.output as JsonValue | undefined
  return isJsonObject(output) && output.success === false
}

/** `client_id=8 · limit=10` — the call's inputs on one line. */
function formatArgs(args: JsonValue | undefined) {
  if (args === undefined || args === null) return ''
  if (!isJsonObject(args)) return truncate(formatJson(args), 90)
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  return truncate(
    entries
      .map(([key, value]) => {
        const text = isJsonString(value)
          ? value
          : formatJson(value).replace(/\s+/g, ' ')
        return `${key}=${truncate(text, 28)}`
      })
      .join(' · '),
    140,
  )
}

export function queuedText(queued: QueuedMessage) {
  // SAFETY: this page only ever sends plain text.
  return queued.content as string
}

function textOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.content)
    .join('')
}

function thinkingOf(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'thinking')
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
    // Each tool call commits on its own, so a failed run may have written some
    // of its calls; with no per-call record left, claim none rather than all.
    if (executionFailed(part)) return []
    return inferWriteCallsFromCode(getTypeScript(part), part.id)
  })
}

function WorkBlock({ call }: { call: WorkCall }) {
  const args = formatArgs(call.args)
  const output = call.error ?? (call.result === undefined ? '' : formatJson(call.result))

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
        Guardado
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
          {card.count === 1
            ? '1 registro guardado'
            : `${card.count} registros guardados`}
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

/** Things an Owner can say on day one, one per kind of work the chat does. */
const examplePrompts = [
  '¿Qué tengo mañana?',
  'Agenda a Rosa el martes a las 10, sesión online',
  'Diego me pagó 35.000 por la sesión de ayer',
  '¿Quién me debe plata?',
]

/**
 * By the practice's clock, not the machine's: the server renders this first,
 * and its zone (UTC in production) must agree with the browser's hydration.
 */
function greeting(now: Date) {
  const hour = Number(
    new Intl.DateTimeFormat('es-CL', {
      timeZone: 'America/Santiago',
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now),
  )
  if (hour < 12) return 'Buenos días'
  if (hour < 20) return 'Buenas tardes'
  return 'Buenas noches'
}

/**
 * A new day's page before anything is said: who it is for, what it does, and
 * a few sentences to start from. Picking one fills the input; it never sends.
 */
function EmptyState({
  ownerName,
  onPick,
}: {
  ownerName: string | undefined
  onPick: (prompt: string) => void
}) {
  // A greeting, not a form letter: "Tomás", not "Tomás Maqui Ríos".
  const firstName = ownerName?.trim().split(/\s+/)[0]
  return (
    <div className="mt-auto flex flex-col gap-7 pb-2">
      <div className="flex flex-col gap-3">
        <h1 className="m-0 font-read text-[34px] font-light leading-[1.15] text-ink">
          {greeting(new Date())}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="m-0 max-w-[520px] font-read text-[19px] font-light leading-[1.55] text-ink-dim">
          Escríbeme como le contarías a una asistente: registro clientes, citas
          y pagos, y te respondo sobre tu agenda y tus cuentas.
        </p>
      </div>
      <div className="flex flex-col font-meta">
        <div className="pb-3 text-[9.5px] uppercase tracking-[0.18em] text-ink-mute">
          Por ejemplo
        </div>
        {examplePrompts.map((prompt) => (
          <button
            className="group flex cursor-pointer items-baseline justify-between gap-6 border-t border-rule py-[11px] text-left font-read text-[17px] font-light italic text-ink-dim last:border-b hover:text-ink"
            key={prompt}
            onClick={() => onPick(prompt)}
            type="button"
          >
            <span>{prompt}</span>
            <span className="shrink-0 font-meta text-[10px] not-italic uppercase tracking-[0.14em] text-ink-faint group-hover:text-ink-mute">
              usar
            </span>
          </button>
        ))}
      </div>
    </div>
  )
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
  const [theme, setTheme] = useState<Theme>('dark')
  const [showWork, setShowWork] = useState(import.meta.env.DEV)
  const messageEnd = useRef<HTMLDivElement>(null)
  const workEnd = useRef<HTMLDivElement>(null)
  const inputField = useRef<HTMLTextAreaElement>(null)
  // Starts pinned, so the first paint of a stored transcript lands on its end.
  const messagesPinned = useRef(true)
  const workPinned = useRef(true)

  // The document already carries the stored theme (an inline script in the root
  // applies it before paint); this only catches the control's label up.
  useEffect(() => {
    const stored = readStored(themeStorageKey)
    if (stored === 'light' || stored === 'dark') setTheme(stored)
    const storedWork = readStored(workStorageKey)
    if (storedWork === 'on' || storedWork === 'off')
      setShowWork(storedWork === 'on')
  }, [])

  const workCalls = messages.flatMap((message) =>
    toolCallPartsOf(message).flatMap(
      (part) => callsByToolCall.get(part.id) ?? [],
    ),
  )

  // Follow new content only while the reader is at the bottom; scrolling up
  // to reread unpins until they come back down.
  useEffect(() => {
    if (messagesPinned.current) messageEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages, queue.length, error, isLoading])

  useEffect(() => {
    if (workPinned.current) workEnd.current?.scrollIntoView({ block: 'end' })
  }, [workCalls.length, callsByToolCall])

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

  const lastAssistantId = messages.findLast(
    (message) => message.role === 'assistant',
  )?.id
  const streamingOnLastAssistant =
    isLoading && messages.at(-1)?.role === 'assistant'

  const dateLabel = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
    .format(new Date())
    .replace(',', '')

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
            <span>Trabajo</span>
            <span>
              {workCalls.length}{' '}
              {workCalls.length === 1 ? 'llamada' : 'llamadas'}
            </span>
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-[18px] pb-6 text-[10.5px] leading-[1.6] text-ink-mute"
            onScroll={(event) => {
              workPinned.current = isPinned(event.currentTarget)
            }}
          >
            {workCalls.length === 0 && (
              <p className="pt-4 text-ink-faint">Sin llamadas en esta sesión.</p>
            )}
            {workCalls.map((call) => (
              <WorkBlock call={call} key={call.key} />
            ))}
            <div ref={workEnd} />
          </div>
          <div className="flex items-center justify-between border-t border-rule px-[18px] py-3 text-[10px] uppercase tracking-[0.14em] text-ink-mute">
            <span>Desarrollo</span>
            <button
              className="cursor-pointer border-b border-ink-mute pb-[2px] uppercase tracking-[0.14em] hover:text-ink"
              onClick={toggleWork}
              type="button"
            >
              ocultar
            </button>
          </div>
        </aside>
      )}

      <main className="flex min-h-0 flex-col">
        <header className="flex items-baseline justify-between border-b border-rule px-11 pb-[18px] pt-6 font-meta text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          <span className="flex gap-6">
            <span>{dateLabel}</span>
            {connectionLabel && <span>{connectionLabel}</span>}
          </span>
          <span className="flex gap-6">
            <button
              className="cursor-pointer uppercase tracking-[0.16em] hover:text-ink"
              onClick={toggleTheme}
              type="button"
            >
              {theme === 'dark' ? 'claro' : 'oscuro'}
            </button>
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
          className={`flex min-h-0 flex-1 flex-col gap-[26px] overflow-y-auto px-11 pt-[30px] font-read text-[19px] font-light leading-[1.6] ${columnWidth}`}
          onScroll={(event) => {
            messagesPinned.current = isPinned(event.currentTarget)
          }}
        >
          {isEmpty && <EmptyState onPick={pickPrompt} ownerName={ownerName} />}

          {messages.map((message) => {
            const text = textOf(message)
            const thinking = thinkingOf(message)
            const summary =
              message.role === 'assistant'
                ? summarizeWrites(callsForMessage(message, callsByToolCall))
                : ({ kind: 'none' } satisfies WriteSummary)
            const showCaret =
              streamingOnLastAssistant && message.id === lastAssistantId
            const showThinking = Boolean(thinking) && (showCaret || !text)

            if (!text && summary.kind === 'none' && !showCaret && !showThinking)
              return null

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
                {showThinking && (
                  <div className="max-w-[86%] whitespace-pre-wrap font-read text-ink-faint">
                    {thinking}
                  </div>
                )}
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

          {queue.map((queued) => (
            <div
              className="flex max-w-[74%] flex-col items-end gap-1 self-end text-right"
              key={queued.id}
            >
              <div className="whitespace-pre-wrap text-ink-faint">
                {queuedText(queued)}
              </div>
              <button
                className="cursor-pointer font-meta text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
                onClick={() => onCancelQueued(queued.id)}
                type="button"
              >
                en cola · cancelar
              </button>
            </div>
          ))}

          {error && (
            <div className="max-w-[86%] border-t border-rule-strong pt-[18px] text-ink">
              {describeChatError(error)}
            </div>
          )}

          <div className="h-[6px] shrink-0" ref={messageEnd} />
        </div>

        <form
          className={`px-11 pb-[30px] pt-[22px] ${columnWidth}`}
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
        >
          <div className="flex items-center gap-5 border border-rule-strong px-[18px] py-[15px]">
            <textarea
              ref={inputField}
              aria-label="Mensaje"
              className="max-h-[40vh] min-h-[27px] flex-1 resize-none bg-transparent font-read text-[18px] font-light leading-[1.5] text-ink outline-none field-sizing-content placeholder:text-ink-ghost disabled:text-ink-mute"
              onChange={(event) => onInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              placeholder="Pregunta, o cuéntame qué pasó…"
              rows={1}
              value={input}
            />
            {isLoading ? (
              <button
                className="shrink-0 cursor-pointer self-center font-meta text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink"
                onClick={onStop}
                type="button"
              >
                detener
              </button>
            ) : (
              <button
                className="shrink-0 cursor-pointer self-center font-meta text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:text-ink disabled:cursor-not-allowed disabled:text-ink-faint disabled:hover:text-ink-faint"
                disabled={!input.trim()}
                type="submit"
              >
                enviar
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  )
}
