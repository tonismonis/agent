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
export function EmptyState({
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
        <div className="font-meta text-meta uppercase pb-3 text-ink-mute">
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
            <span className="font-meta text-meta uppercase shrink-0 not-italic text-ink-faint group-hover:text-ink-mute">
              usar
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
