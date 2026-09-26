import { parsePartialJSON } from '@tanstack/ai'
import { useEffect, useRef, useState, type ReactNode } from 'react'

import { formatJson, isJsonObject, isJsonString, type JsonValue } from '#/lib/json'
import {
  defaultPaperChoice,
  paperStorageKey,
  papers,
  pickPaper,
  readPaperChoice,
  showPaper,
  type Paper,
  type PaperChoice,
} from '#/lib/paper'
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

/** The live calls one turn made, as code-mode events reported them. */
function liveCallsOf(
  message: UIMessage,
  callsByToolCall: Map<string, Array<WorkCall>>,
) {
  return toolCallPartsOf(message).flatMap(
    (part) => callsByToolCall.get(part.id) ?? [],
  )
}

/** Back-to-back calls to one tool: three bookings read as one entry. */
type CallRun = { key: string; name: string; calls: Array<WorkCall> }

function foldCalls(calls: Array<WorkCall>) {
  const runs: Array<CallRun> = []
  for (const call of calls) {
    const last = runs.at(-1)
    if (last?.name === call.name) last.calls.push(call)
    else runs.push({ key: call.key, name: call.name, calls: [call] })
  }
  return runs
}

function totalMs(calls: Array<WorkCall>) {
  return calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
}

/** `3 llamadas · 114 ms · 1 error` */
function describeWork(calls: Array<WorkCall>) {
  const errors = calls.filter((call) => call.error !== undefined).length
  const ms = totalMs(calls)
  return [
    calls.length === 1 ? '1 llamada' : `${calls.length} llamadas`,
    ms > 0 ? `${ms} ms` : null,
    errors === 0 ? null : errors === 1 ? '1 error' : `${errors} errores`,
  ]
    .filter(Boolean)
    .join(' · ')
}

function WorkBlock({ run }: { run: CallRun }) {
  // A lone call shows what came back; a run shows each call's inputs.
  const single = run.calls.length === 1 ? run.calls[0] : undefined
  // One flowing line, clamped: a tall result would push the conversation apart.
  const output =
    single?.error ??
    (single?.result === undefined
      ? ''
      : formatJson(single.result).replace(/\s+/g, ' '))
  const finished = run.calls.filter((call) => call.durationMs !== undefined)

  return (
    <div className="flex flex-col gap-1 border-t border-rule pt-3">
      <div className="flex justify-between gap-3 text-ink-dim">
        <span className="break-all">
          {run.name}
          {!single && ` ×${run.calls.length}`}
        </span>
        {finished.length > 0 && (
          <span className="shrink-0 text-ink-faint">{totalMs(finished)} ms</span>
        )}
      </div>
      {run.calls.map((call) => {
        const args = formatArgs(call.args)
        const error = single ? undefined : call.error
        if (!args && !error) return null
        return (
          <div key={call.key}>
            {args}
            {error && <span className="text-ink"> · {error}</span>}
          </div>
        )
      })}
      {output && (
        <div className="line-clamp-3 break-all text-[10px] leading-[1.55] text-ink-faint">
          {truncate(output, 400)}
        </div>
      )}
    </div>
  )
}

function WorkCalls({ calls }: { calls: Array<WorkCall> }) {
  return (
    <div className="flex flex-col gap-3 font-meta text-[10.5px] leading-[1.6] text-ink-mute">
      {foldCalls(calls).map((run) => (
        <WorkBlock key={run.key} run={run} />
      ))}
    </div>
  )
}

/**
 * Viewports wide enough to set a turn's calls in the margin beside it
 * ((1376 − 816) / 2 = 280px); narrower ones fold them under the reply.
 */
const marginClass = 'hidden min-[1376px]:block'
const inlineClass = 'min-[1376px]:hidden'

/**
 * One line of the conversation: the 816px column centered on the screen,
 * with the right margin free for notes, so showing work never moves the text.
 */
function Row({
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
  const firstName = ownerName?.trim().split(/\s+/)[0]
  return (
    <div className="mt-auto flex flex-col gap-7 pb-2">
      <div className="flex flex-col gap-3">
        <h1 className="m-0 font-read text-[34px] font-light leading-[1.15] text-ink">
          {greeting(new Date())}
          {firstName ? `, ${firstName}` : ''}.
        </h1>
        <p className="m-0 max-w-[520px] font-read text-[19px] font-light leading-[1.55] text-ink-dim">
          Escríbeme como le contarías a un asistente: registro clientes, citas
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

const paperModes = [
  { mode: 'light', label: 'Papel claro' },
  { mode: 'dark', label: 'Papel oscuro' },
] as const

/**
 * Bottom left, in the margin the conversation leaves free; only where that
 * margin is wide enough to hold it ((1200 − 816) / 2 = 192px).
 */
function PaperPicker({
  choice,
  onPick,
}: {
  choice: PaperChoice
  onPick: (paper: Paper) => void
}) {
  return (
    <div className="fixed bottom-[30px] left-11 hidden flex-col gap-4 font-meta text-[10px] uppercase tracking-[0.16em] text-ink-mute min-[1200px]:flex">
      {paperModes.map(({ mode, label }) => (
        <div
          aria-label={label}
          className="flex flex-col gap-2"
          key={mode}
          role="group"
        >
          <span>{label}</span>
          {papers
            .filter((paper) => paper.mode === mode)
            .map((paper) => {
              const picked = choice[mode] === paper.id
              const shown = picked && choice.mode === mode
              return (
                <button
                  aria-pressed={picked}
                  className={`flex cursor-pointer items-center gap-3 uppercase tracking-[0.16em] hover:text-ink ${picked ? 'text-ink' : ''}`}
                  key={paper.id}
                  onClick={() => onPick(paper)}
                  type="button"
                >
                  <span
                    className={`border p-px ${shown ? 'border-ink' : 'border-rule-strong'}`}
                  >
                    {/* --paper-ground, not bg-ground: --color-ground resolves
                        once on <html> and arrives here already computed. */}
                    <span
                      className="block h-3.5 w-3.5 bg-(--paper-ground)"
                      data-paper={paper.id}
                    />
                  </span>
                  {paper.name}
                </button>
              )
            })}
        </div>
      ))}
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
  const [paper, setPaper] = useState<PaperChoice>(defaultPaperChoice)
  const [showWork, setShowWork] = useState(import.meta.env.DEV)
  // Turns whose calls are unfolded under the reply, on screens without a margin.
  const [openWork, setOpenWork] = useState<ReadonlySet<string>>(new Set())
  const messageEnd = useRef<HTMLDivElement>(null)
  const inputField = useRef<HTMLTextAreaElement>(null)
  // Starts pinned, so the first paint of a stored transcript lands on its end.
  const messagesPinned = useRef(true)

  // The document already carries the stored paper (an inline script in the root
  // applies it before paint); this only catches the controls' labels up.
  useEffect(() => {
    setPaper(readPaperChoice(readStored(paperStorageKey)))
    const storedWork = readStored(workStorageKey)
    if (storedWork === 'on' || storedWork === 'off')
      setShowWork(storedWork === 'on')
  }, [])

  // Follow new content only while the reader is at the bottom; scrolling up
  // to reread unpins until they come back down.
  useEffect(() => {
    if (messagesPinned.current) messageEnd.current?.scrollIntoView({ block: 'end' })
  }, [messages, callsByToolCall, queue.length, error, isLoading])

  function choosePaper(picked: Paper) {
    const next = pickPaper(paper, picked)
    setPaper(next)
    showPaper(next)
  }

  function toggleWork() {
    const next = !showWork
    setShowWork(next)
    writeStored(workStorageKey, next ? 'on' : 'off')
  }

  function toggleTurnWork(messageId: string) {
    setOpenWork((current) => {
      const next = new Set(current)
      if (!next.delete(messageId)) next.add(messageId)
      return next
    })
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
          const calls = showWork ? liveCallsOf(message, callsByToolCall) : []

          if (
            !text &&
            summary.kind === 'none' &&
            !showCaret &&
            !showThinking &&
            calls.length === 0
          )
            return null

          if (message.role === 'user') {
            return (
              <Row key={message.id}>
                <div className="max-w-[74%] self-end whitespace-pre-wrap text-right text-ink-dim">
                  {text}
                </div>
              </Row>
            )
          }

          const workOpen = openWork.has(message.id)

          return (
            <Row
              key={message.id}
              margin={
                calls.length > 0 && (
                  <div className="flex flex-col gap-3">
                    <div className="font-meta text-[10px] uppercase tracking-[0.16em] text-ink-faint">
                      {describeWork(calls)}
                    </div>
                    <WorkCalls calls={calls} />
                  </div>
                )
              }
            >
              <div className="flex flex-col gap-[18px]">
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
                {calls.length > 0 && (
                  <div className={`flex max-w-[86%] flex-col gap-3 ${inlineClass}`}>
                    <button
                      aria-expanded={workOpen}
                      className="cursor-pointer self-start font-meta text-[10px] uppercase tracking-[0.16em] text-ink-faint hover:text-ink"
                      onClick={() => toggleTurnWork(message.id)}
                      type="button"
                    >
                      {describeWork(calls)} · {workOpen ? 'ocultar' : 'ver'}
                    </button>
                    {workOpen && (
                      <div className="border-l border-rule pl-[14px]">
                        <WorkCalls calls={calls} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Row>
          )
        })}

        {isLoading && !streamingOnLastAssistant && (
          <Row>
            <div className="max-w-[86%]">
              <Caret />
            </div>
          </Row>
        )}

        {queue.map((queued) => (
          <Row key={queued.id}>
            <div className="flex max-w-[74%] flex-col items-end gap-1 self-end text-right">
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
          </Row>
        ))}

        {error && (
          <Row>
            <div className="max-w-[86%] border-t border-rule-strong pt-[18px] text-ink">
              {describeChatError(error)}
            </div>
          </Row>
        )}

        <div className="h-[6px] shrink-0" ref={messageEnd} />
      </div>

      <PaperPicker choice={paper} onPick={choosePaper} />

      <form
        className="mx-auto w-full max-w-[816px] px-11 pb-[30px] pt-[22px]"
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
  )
}
