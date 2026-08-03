import { createFileRoute } from '@tanstack/react-router'
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getDailyThreadId,
  millisecondsUntilThreadRotation,
} from '#/lib/chat-thread'
import { CHAT_MODEL } from '#/lib/inference-config'
import type { UIMessage } from '@tanstack/ai-react'

type CodeModeEvent = {
  id: number
  type: string
  data: unknown
}

type ToolCallPart = Extract<UIMessage['parts'][number], { type: 'tool-call' }>

export const Route = createFileRoute('/_authenticated/')({ component: Home })

function formatValue(value: unknown) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
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

function EventRow({ event }: { event: CodeModeEvent }) {
  const data = event.data as Record<string, unknown> | null
  const name = typeof data?.function === 'string' ? data.function : null
  const duration = typeof data?.duration === 'number' ? `${data.duration}ms` : null

  return (
    <li className="border-t border-zinc-800 py-2 first:border-t-0">
      <div className="flex flex-wrap gap-x-2 text-zinc-400">
        <span>{event.type.replace('code_mode:', '')}</span>
        {name && <span className="text-zinc-200">{name}</span>}
        {duration && <span>{duration}</span>}
      </div>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-zinc-300">
        {formatValue(event.data)}
      </pre>
    </li>
  )
}

function InstrumentationCall({
  part,
  events,
}: {
  part: ToolCallPart
  events: Array<CodeModeEvent>
}) {
  const detailsInitialized = useRef(false)

  return (
    <section className="border border-zinc-800 bg-zinc-950">
      <details
        ref={(details) => {
          if (!details || detailsInitialized.current) return
          details.open = part.state !== 'complete'
          detailsInitialized.current = true
        }}
      >
        <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-zinc-300">
          {part.name} · {part.state}
        </summary>
        <pre className="max-h-72 overflow-auto border-t border-zinc-800 p-3 text-xs leading-5 text-emerald-300">
          {getTypeScript(part.arguments)}
        </pre>
      </details>
      <ul className="px-3 font-mono text-[11px] leading-4">
        {events.map((event) => (
          <EventRow event={event} key={event.id} />
        ))}
      </ul>
      {part.output !== undefined && (
        <details className="border-t border-zinc-800">
          <summary className="cursor-pointer px-3 py-2 font-mono text-xs text-zinc-400">
            execution output
          </summary>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words border-t border-zinc-800 p-3 font-mono text-xs text-zinc-300">
            {formatValue(part.output)}
          </pre>
        </details>
      )}
    </section>
  )
}

function Home() {
  const [input, setInput] = useState('')
  const [threadId, setThreadId] = useState(() => getDailyThreadId())
  const [eventsByCall, setEventsByCall] = useState<
    Map<string, Array<CodeModeEvent>>
  >(new Map())
  const eventId = useRef(0)
  const messageScroll = useRef<HTMLDivElement>(null)
  const messageEnd = useRef<HTMLDivElement>(null)
  const instrumentationScroll = useRef<HTMLElement>(null)
  const instrumentationEnd = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setThreadId(getDailyThreadId())
    }, millisecondsUntilThreadRotation())
    return () => window.clearTimeout(timeout)
  }, [threadId])

  const scrollIfPinned = useCallback(
    (
      container: HTMLElement | null,
      anchor: HTMLDivElement | null,
    ) => {
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

  const scrollInstrumentation = useCallback(() => {
    scrollIfPinned(instrumentationScroll.current, instrumentationEnd.current)
  }, [scrollIfPinned])

  const onCustomEvent = useCallback(
    (type: string, data: unknown, context: { toolCallId?: string }) => {
      if (!type.startsWith('code_mode:') || !context.toolCallId) return

      const event = { id: eventId.current++, type, data }
      setEventsByCall((current) => {
        const next = new Map(current)
        next.set(context.toolCallId!, [
          ...(next.get(context.toolCallId!) ?? []),
          event,
        ])
        return next
      })
      scrollInstrumentation()
    },
    [scrollInstrumentation],
  )

  const { messages, sendMessage, isLoading, error, status } = useChat({
    threadId,
    connection: fetchServerSentEvents('/api/chat'),
    persistence: true,
    onChunk: (chunk) => {
      if (chunk.type === 'TEXT_MESSAGE_CONTENT') scrollMessages()
      if (chunk.type.startsWith('TOOL_CALL_')) scrollInstrumentation()
    },
    onCustomEvent,
  })

  const toolCalls = messages.flatMap((message) =>
    message.parts.filter(
      (part): part is ToolCallPart => part.type === 'tool-call',
    ),
  )

  async function submit() {
    const message = input.trim()
    if (!message || isLoading) return
    setInput('')
    const sending = sendMessage(message)
    scrollMessages()
    await sending
  }

  return (
    <main className="flex h-screen flex-col bg-white text-zinc-950">
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-zinc-300 px-4 font-mono text-xs">
        <strong>CRM agent probe</strong>
        <span>model: {CHAT_MODEL}</span>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-2">
        <section className="flex min-h-0 flex-col border-r border-zinc-300">
          <div
            className="min-h-0 flex-1 overflow-y-auto p-4"
            ref={messageScroll}
          >
            {messages.length === 0 && (
              <p className="text-sm text-zinc-500">Send a CRM question.</p>
            )}
            <div className="space-y-4">
              {messages.map((message) => {
                const text = message.parts
                  .filter((part) => part.type === 'text')
                  .map((part) => part.content)
                  .join('')
                if (!text) return null

                return (
                  <div
                    className={`flex ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    key={message.id}
                  >
                    <div
                      className={`max-w-[80%] whitespace-pre-wrap px-3 py-2 text-sm ${
                        message.role === 'user'
                          ? 'bg-zinc-900 text-white'
                          : 'border border-zinc-300 bg-zinc-50'
                      }`}
                    >
                      {text}
                    </div>
                  </div>
                )
              })}
              {isLoading && <p className="text-xs text-zinc-500">streaming…</p>}
              {error && <p className="text-sm text-red-700">{error.message}</p>}
              <div ref={messageEnd} />
            </div>
          </div>

          <form
            className="border-t border-zinc-300 p-3"
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <textarea
              aria-label="Message"
              className="block h-24 w-full resize-none border border-zinc-400 p-2 text-sm outline-none focus:border-zinc-950 disabled:bg-zinc-100"
              disabled={isLoading}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  void submit()
                }
              }}
              placeholder="Ask about customers, products, or purchases…"
              value={input}
            />
            <div className="mt-2 flex items-center justify-between">
              <span className="font-mono text-xs text-zinc-500">{status}</span>
              <button
                className="bg-zinc-900 px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:bg-zinc-400"
                disabled={isLoading || !input.trim()}
                type="submit"
              >
                Send
              </button>
            </div>
          </form>
        </section>

        <aside
          className="min-h-0 overflow-y-auto bg-zinc-900 p-4 text-white"
          ref={instrumentationScroll}
        >
          <div className="mb-3 flex items-baseline justify-between">
            <h1 className="font-mono text-sm font-bold">INSTRUMENTATION</h1>
            <span className="font-mono text-xs text-zinc-500">
              {toolCalls.length} calls
            </span>
          </div>
          <div className="space-y-3">
            {toolCalls.length === 0 && (
              <p className="font-mono text-xs text-zinc-500">
                Waiting for tool calls.
              </p>
            )}
            {toolCalls.map((part) => (
              <InstrumentationCall
                events={eventsByCall.get(part.id) ?? []}
                key={part.id}
                part={part}
              />
            ))}
            <div ref={instrumentationEnd} />
          </div>
        </aside>
      </div>
    </main>
  )
}
