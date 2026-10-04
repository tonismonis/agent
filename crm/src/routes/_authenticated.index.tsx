import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadChatPage, readTranscript } from '#/lib/chat-page.functions'
import { getDailyThreadId, millisecondsUntilThreadRotation } from '#/lib/chat-thread'
import { readCodeModeEvent } from '#/lib/code-mode-events'
import type { JsonValue } from '#/lib/json'
import { writeEvent, writeEventName, type Write } from '#/lib/receipt-facts'
import type { WorkCall } from '#/lib/write-receipts'
import { ChatView } from '#/routes/-chat/chat-view'
import { queuedText } from '#/routes/-chat/select-turns'
import type { UseChatOptions } from '@tanstack/ai-react'

export const Route = createFileRoute('/_authenticated/')({
  loader: () => loadChatPage(),
  component: Home,
})

const connection = fetchServerSentEvents('/api/chat')

function Home() {
  const page = Route.useLoaderData()
  const loadedMessages = useMemo(
    () => readTranscript(page.transcript),
    [page.transcript],
  )
  const [input, setInput] = useState('')
  const [hasSent, setHasSent] = useState(false)
  const [threadId, setThreadId] = useState(page.threadId)
  const [callsByToolCall, setCallsByToolCall] = useState<
    Map<string, Array<WorkCall>>
  >(new Map())
  const [writesByToolCall, setWritesByToolCall] = useState<
    Map<string, Array<Write>>
  >(new Map())
  const callKey = useRef(0)

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setThreadId(getDailyThreadId())
    }, millisecondsUntilThreadRotation())
    return () => window.clearTimeout(timeout)
  }, [threadId])

  const onCustomEvent = useCallback<
    NonNullable<UseChatOptions['onCustomEvent']>
  >((type, data, context) => {
    const toolCallId = context.toolCallId
    if (!toolCallId) return
    if (type === writeEventName) {
      const write = writeEvent.safeParse(data)
      if (!write.success) return
      setWritesByToolCall((current) =>
        new Map(current).set(toolCallId, [
          ...(current.get(toolCallId) ?? []),
          write.data,
        ]),
      )
      return
    }
    if (!type.startsWith('code_mode:')) return
    // SAFETY: a custom event carries the JSON the tool serialized onto the stream.
    const event = readCodeModeEvent(type, data as JsonValue)
    if (!event) return

    setCallsByToolCall((current) => {
      const calls = [...(current.get(toolCallId) ?? [])]

      if (event.kind === 'call') {
        calls.push({
          key: `${toolCallId}:${callKey.current++}`,
          toolCallId,
          name: event.name,
          args: event.args,
        })
      } else if (event.kind === 'failed') {
        calls.push({
          key: `${toolCallId}:${callKey.current++}`,
          toolCallId,
          name: 'execute_typescript',
          durationMs: event.durationMs,
          error: event.message,
          ...(event.refused && { refused: true as const }),
        })
      } else {
        // Calls of one name finish roughly in the order they started, so the
        // earliest unfinished one is the likeliest owner of this result.
        const index = calls.findIndex(
          (call) =>
            call.name === event.name &&
            call.result === undefined &&
            call.error === undefined,
        )
        if (index === -1) return current
        calls[index] = {
          ...calls[index]!,
          durationMs: event.durationMs,
          ...(event.kind === 'result'
            ? { result: event.result }
            : {
                error: event.message,
                ...(event.refused && { refused: true as const }),
              }),
        }
      }

      const next = new Map(current)
      next.set(toolCallId, calls)
      return next
    })
  }, [])

  const {
    messages,
    sendMessage,
    isLoading,
    error,
    stop,
    connectionStatus,
    queue,
    cancelQueued,
  } = useChat({
    threadId,
    connection,
    persistence: true,
    // The server already rendered the loaded day; a day rolled over since
    // starts empty and hydrates like any other.
    initialMessages: threadId === page.threadId ? loadedMessages : undefined,
    onCustomEvent,
    // A failed run discards the send queue; hand the unsent text back rather
    // than lose it. `queue` here is the render before the discard lands.
    onError: () => {
      if (queue.length === 0) return
      const unsent = queue.map(queuedText)
      setInput((current) => [...unsent, current].filter(Boolean).join('\n\n'))
    },
  })

  function submit() {
    const message = input.trim()
    if (!message) return
    setInput('')
    setHasSent(true)
    // While a reply streams this queues; it sends when the reply finishes.
    void sendMessage(message)
  }

  function stopRun() {
    stop()
    // stop() only detaches this client; the run itself is server-side.
    void fetch('/api/chat', { method: 'DELETE' })
  }

  // Loading before this page sent anything is the client reattaching to a run
  // a previous page started. 'disconnected' is this adapter's idle state and
  // 'connecting' fires on every send, so only 'error' reads as degraded.
  const connectionLabel =
    isLoading && !hasSent
      ? 'retomando'
      : connectionStatus === 'error'
        ? 'sin conexión'
        : null

  return (
    <ChatView
      callsByToolCall={callsByToolCall}
      writesByToolCall={writesByToolCall}
      connectionLabel={connectionLabel}
      error={error}
      input={input}
      isLoading={isLoading}
      messages={messages}
      onCancelQueued={cancelQueued}
      onInputChange={setInput}
      onStop={stopRun}
      onSubmit={submit}
      ownerName={page.ownerName}
      queue={queue}
    />
  )
}
