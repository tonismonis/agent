import type { WriteSummary } from '#/lib/write-receipts'

function FieldRow({
  label,
  value,
  labelClassName,
  valueClassName,
}: {
  label: string
  value: string
  labelClassName?: string
  valueClassName: string
}) {
  return (
    <div className="flex justify-between gap-5">
      <span className={labelClassName}>{label}</span>
      <span className={valueClassName}>{value}</span>
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
      <div className="font-meta text-meta uppercase text-ink-mute">
        Guardado
      </div>
      {receipt.lines.map((line) => (
        <FieldRow
          key={`${line.label}-${line.value}`}
          label={line.label}
          value={line.value}
          valueClassName="text-right text-ink-dim"
        />
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
      <div className="font-meta text-meta uppercase flex items-baseline justify-between gap-5 text-ink-mute">
        <span>{card.subject}</span>
        <span className="shrink-0 text-right">
          {card.count === 1
            ? '1 registro guardado'
            : `${card.count} registros guardados`}
        </span>
      </div>
      <div className="flex flex-col gap-[2px] font-meta text-[12px] leading-[1.7] text-ink-2">
        {card.rows.map((row) => (
          <FieldRow
            key={row.label}
            label={row.label}
            labelClassName="text-ink-mute"
            value={row.value}
            valueClassName="text-right"
          />
        ))}
      </div>
    </div>
  )
}

export function WriteSummaryView({ summary }: { summary: WriteSummary }) {
  if (summary.kind === 'card') return <RecordCard card={summary} />
  if (summary.kind === 'receipt') return <WriteReceipt receipt={summary} />
  return null
}
