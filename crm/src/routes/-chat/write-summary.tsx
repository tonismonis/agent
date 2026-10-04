import { receiptLines } from '#/lib/write-receipts'
import type { ReceiptFact } from '#/lib/receipt-facts'

/**
 * What the turn saved, one line per fact, under a 2px rule. While a write is
 * in flight the header shimmers as "Guardando"; each line opens in as its
 * write saves, and a growing count updates its line in place.
 */
export function WriteReceipt({
  facts,
  saving,
}: {
  facts: Array<ReceiptFact>
  saving: boolean
}) {
  const lines = receiptLines(facts)
  if (lines.length === 0 && !saving) return null
  return (
    <div className="flex max-w-[86%] flex-col border-l-2 border-ink py-0.5 pl-4 font-meta text-[11.5px] leading-[1.5]">
      <div
        className={
          saving
            ? 'w-fit animate-shimmer bg-[linear-gradient(90deg,var(--color-ink-mute)_35%,var(--color-ink)_50%,var(--color-ink-mute)_65%)] bg-size-[200%_100%] bg-clip-text font-meta text-meta uppercase text-transparent motion-reduce:animate-none'
            : 'font-meta text-meta uppercase text-ink-mute'
        }
      >
        {saving ? 'Guardando' : 'Guardado'}
      </div>
      {lines.map((line) => (
        <div
          key={line.key}
          className="grid grid-rows-[1fr] opacity-100 transition-[grid-template-rows,opacity] duration-300 ease-out starting:grid-rows-[0fr] starting:opacity-0"
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex justify-between gap-5 pt-[9px]">
              <span>{line.label}</span>
              <span className="text-right text-ink-dim">{line.value}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
