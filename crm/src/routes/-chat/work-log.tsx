import { TextButton } from '#/components/ui/text-button'
import { formatJson, isJsonObject, isJsonString, type JsonValue } from '#/lib/json'
import type { WorkCall } from '#/lib/write-receipts'

export function truncate(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/** `client_id=8 · limit=10` — the call's inputs on one line. */
export function formatArgs(args: JsonValue | undefined) {
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

/** Back-to-back calls to one tool: three bookings read as one entry. */
type CallRun = { key: string; name: string; calls: Array<WorkCall> }

export function foldCalls(calls: Array<WorkCall>) {
  const runs: Array<CallRun> = []
  for (const call of calls) {
    const last = runs.at(-1)
    if (last?.name === call.name) last.calls.push(call)
    else runs.push({ key: call.key, name: call.name, calls: [call] })
  }
  return runs
}

export function totalMs(calls: Array<WorkCall>) {
  return calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0)
}

/** `3 llamadas · 114 ms · 1 rechazada · 1 error` */
export function describeWork(calls: Array<WorkCall>) {
  const failed = calls.filter((call) => call.error !== undefined)
  const refused = failed.filter((call) => call.refused).length
  const errors = failed.length - refused
  const ms = totalMs(calls)
  return [
    calls.length === 1 ? '1 llamada' : `${calls.length} llamadas`,
    ms > 0 ? `${ms} ms` : null,
    refused === 0 ? null : refused === 1 ? '1 rechazada' : `${refused} rechazadas`,
    errors === 0 ? null : errors === 1 ? '1 error' : `${errors} errores`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/**
 * Viewports from the `margin` breakpoint up are wide enough to set a turn's
 * calls in the margin beside it; narrower ones fold them under the reply.
 */
export const marginClass = 'hidden margin:block'
const inlineClass = 'margin:hidden'

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

/** A turn's calls in the margin beside it. */
export function WorkMargin({ calls }: { calls: Array<WorkCall> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="font-meta text-meta uppercase text-ink-faint">
        {describeWork(calls)}
      </div>
      <WorkCalls calls={calls} />
    </div>
  )
}

/** A turn's calls folded under the reply, on screens without a margin. */
export function WorkToggle({
  calls,
  open,
  onToggle,
}: {
  calls: Array<WorkCall>
  open: boolean
  onToggle: () => void
}) {
  return (
    <div className={`flex max-w-[86%] flex-col gap-3 ${inlineClass}`}>
      <TextButton
        aria-expanded={open}
        className="self-start"
        onClick={onToggle}
        tone="faint"
      >
        {describeWork(calls)} · {open ? 'ocultar' : 'ver'}
      </TextButton>
      {open && (
        <div className="border-l border-rule pl-[14px]">
          <WorkCalls calls={calls} />
        </div>
      )}
    </div>
  )
}
