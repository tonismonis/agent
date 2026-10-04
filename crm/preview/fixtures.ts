/**
 * Canned chat states for designing against. Each state is exactly the props
 * the app route would hand ChatView at that moment, minus the handlers.
 */
import type { ChatViewProps } from '#/routes/-chat/chat-view'
import type { JsonValue } from '#/lib/json'
import type { ReceiptFact } from '#/lib/receipt-facts'
import type { WorkCall } from '#/lib/write-receipts'
import type { QueuedMessage, UIMessage } from '@tanstack/ai-react'

export type ChatState = Pick<
  ChatViewProps,
  | 'messages'
  | 'callsByToolCall'
  | 'isLoading'
  | 'error'
  | 'queue'
  | 'connectionLabel'
  | 'ownerName'
>

let nextId = 0
const id = (prefix: string) => `${prefix}-${nextId++}`

function user(text: string): UIMessage {
  return { id: id('user'), role: 'user', parts: [{ type: 'text', content: text }] }
}

function assistant(
  text: string,
  toolCallId?: string,
  code = '',
  receipt: Array<ReceiptFact> = [],
): UIMessage {
  return {
    id: id('assistant'),
    role: 'assistant',
    parts: [
      ...(toolCallId
        ? [
            {
              type: 'tool-call' as const,
              id: toolCallId,
              name: 'execute_typescript',
              arguments: JSON.stringify({ typescriptCode: code }),
              input: { typescriptCode: code },
              state: 'complete' as const,
              output: {
                success: true,
                result: null,
                logs: [],
                ...(receipt.length > 0 && { receipt }),
              },
            },
          ]
        : []),
      { type: 'text', content: text },
    ],
  }
}

function call(
  toolCallId: string,
  name: string,
  args: JsonValue,
  result: JsonValue,
  durationMs = 38,
): WorkCall {
  return { key: id(toolCallId), toolCallId, name, args, result, durationMs }
}

function queued(text: string): QueuedMessage {
  return { id: id('queued'), content: text, createdAt: Date.now() }
}

const idle = {
  ownerName: 'Tomás',
  isLoading: false,
  error: undefined,
  queue: [],
  connectionLabel: null,
} satisfies Partial<ChatState>

const rosa = { id: 12, name: 'Rosa Valdés', phone: '+56 9 4412 8890', email: null }

/** Three turns: a lookup, a single-field update, a run of three bookings. */
function conversation() {
  const messages = [
    user('¿Qué tengo mañana?'),
    assistant(
      'Mañana tienes dos sesiones: Rosa Valdés a las 10:00 y Diego Paredes a las 16:30. Nada más agendado.',
      'call_agenda',
      'return await external_findAppointments({ from: "2026-09-24", to: "2026-09-25" })',
    ),
    user('Rosa cambió su teléfono, ahora es +56 9 4412 8890'),
    assistant(
      'Listo, actualicé el teléfono de Rosa.',
      'call_phone',
      'const [c] = await external_findClients({ query: "Rosa" })\nreturn await external_updateClient({ id: c.id, phone: "+56 9 4412 8890" })',
      [
        {
          entity: 'client',
          action: 'updated',
          subject: rosa.name,
          count: 1,
          changes: [{ field: 'phone', value: rosa.phone }],
        },
      ],
    ),
    user(
      'Agenda a Rosa los próximos tres martes a las 10, sesión individual, online',
    ),
    assistant(
      'Agendé las tres sesiones de Rosa: 30 de septiembre, 7 y 14 de octubre, a las 10:00, online.',
      'call_book',
      'for (const d of dates) await external_createAppointment({ client_id: 12, service_id: 3, starts_at: d, mode: "online" })',
      [
        {
          entity: 'appointment',
          action: 'created',
          client: rosa.name,
          count: 3,
          starts_at: null,
          changes: [],
        },
      ],
    ),
  ]
  const booking = (date: string) =>
    call(
      'call_book',
      'createAppointment',
      { client_id: 12, service_id: 3, starts_at: `${date}T13:00:00Z`, mode: 'online' },
      {
        id: 40,
        client_id: 12,
        starts_at: `${date}T13:00:00.000Z`,
        ends_at: `${date}T14:00:00.000Z`,
        mode: 'online',
        price: 40000,
      },
    )
  const callsByToolCall = new Map<string, Array<WorkCall>>([
    [
      'call_agenda',
      [
        call(
          'call_agenda',
          'findAppointments',
          { from: '2026-09-24', to: '2026-09-25' },
          [
            { id: 31, client_id: 12, starts_at: '2026-09-24T13:00:00.000Z' },
            { id: 32, client_id: 7, starts_at: '2026-09-24T19:30:00.000Z' },
          ],
          22,
        ),
      ],
    ],
    [
      'call_phone',
      [
        call('call_phone', 'findClients', { query: 'Rosa' }, [rosa], 14),
        call(
          'call_phone',
          'updateClient',
          { id: 12, phone: '+56 9 4412 8890' },
          rosa,
          31,
        ),
      ],
    ],
    [
      'call_book',
      [booking('2026-09-30'), booking('2026-10-07'), booking('2026-10-14')],
    ],
  ])
  return { messages, callsByToolCall }
}

const partialReply =
  'Revisé tu semana. El martes tienes tres sesiones seguidas desde las 9:00 y el jueves'

function withStreamingReply() {
  const { messages, callsByToolCall } = conversation()
  return {
    messages: [
      ...messages,
      user('¿Cómo viene mi semana?'),
      assistant(partialReply),
    ],
    callsByToolCall,
  }
}

function longHistory() {
  const messages: Array<UIMessage> = []
  for (let day = 1; day <= 20; day++) {
    messages.push(user(`Registra el pago de la sesión ${day} de Diego, 35.000`))
    messages.push(
      assistant(
        `Registré el pago de $35.000 de Diego Paredes por la sesión ${day}. Con esto lleva ${day} sesiones pagadas este año.`,
      ),
    )
  }
  return { messages, callsByToolCall: new Map<string, Array<WorkCall>>() }
}

export const states = {
  empty: () => ({
    ...idle,
    messages: [],
    callsByToolCall: new Map<string, Array<WorkCall>>(),
  }),
  conversation: () => ({ ...idle, ...conversation() }),
  waiting: () => {
    const { messages, callsByToolCall } = conversation()
    return {
      ...idle,
      isLoading: true,
      messages: [...messages, user('¿Cuánto me pagaron este mes?')],
      callsByToolCall,
    }
  },
  streaming: () => ({ ...idle, isLoading: true, ...withStreamingReply() }),
  queued: () => ({
    ...idle,
    isLoading: true,
    ...withStreamingReply(),
    queue: [
      queued('Y agenda a Diego el viernes a las 16:30'),
      queued('¿Quién me debe plata?'),
    ],
  }),
  resuming: () => ({
    ...idle,
    isLoading: true,
    connectionLabel: 'retomando',
    ...withStreamingReply(),
  }),
  offline: () => ({ ...idle, connectionLabel: 'sin conexión', ...conversation() }),
  busy: () => ({
    ...idle,
    ...conversation(),
    error: new Error('HTTP error! status: 409 Conflict'),
  }),
  failed: () => ({
    ...idle,
    ...conversation(),
    error: new Error('The run failed'),
  }),
  long: () => ({ ...idle, ...longHistory() }),
} satisfies Record<string, () => ChatState>

export type StateName = keyof typeof states
