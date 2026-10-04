import { receiptLines } from '#/lib/write-receipts'
import type { ReceiptFact } from '#/lib/receipt-facts'

/** What the turn saved, one line per fact, under a 2px rule. */
export function WriteReceipt({ facts }: { facts: Array<ReceiptFact> }) {
  const lines = receiptLines(facts)
  if (lines.length === 0) return null
  return (
    <div className="flex max-w-[86%] flex-col gap-[9px] border-l-2 border-ink py-0.5 pl-4 font-meta text-[11.5px] leading-[1.5]">
      <div className="font-meta text-meta uppercase text-ink-mute">
        Guardado
      </div>
      {lines.map((line) => (
        <div key={`${line.label}-${line.value}`} className="flex justify-between gap-5">
          <span>{line.label}</span>
          <span className="text-right text-ink-dim">{line.value}</span>
        </div>
      ))}
    </div>
  )
}
