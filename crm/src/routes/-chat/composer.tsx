import type { Ref } from 'react'

import { TextButton } from '#/components/ui/text-button'

export function Composer({
  ref,
  input,
  isLoading,
  onInputChange,
  onSubmit,
  onStop,
}: {
  ref: Ref<HTMLTextAreaElement>
  input: string
  isLoading: boolean
  onInputChange: (value: string) => void
  onSubmit: () => void
  onStop: () => void
}) {
  return (
    <form
      className="mx-auto w-full max-w-column px-11 pb-7.5 pt-5.5"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className="flex items-center gap-5 border border-rule-strong px-4.5 py-[15px]">
        <textarea
          ref={ref}
          aria-label="Mensaje"
          className="max-h-[40vh] min-h-[27px] flex-1 resize-none bg-transparent font-read text-[18px] font-light leading-[1.5] text-ink outline-none field-sizing-content placeholder:text-ink-ghost disabled:text-ink-mute"
          onChange={(event) => onInputChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder="Pregunta, o cuéntame qué pasó…"
          rows={1}
          value={input}
        />
        {isLoading ? (
          <TextButton className="shrink-0 self-center" onClick={onStop} tone="mute">
            detener
          </TextButton>
        ) : (
          <TextButton
            className="shrink-0 self-center"
            disabled={!input.trim()}
            tone="mute"
            type="submit"
          >
            enviar
          </TextButton>
        )}
      </div>
    </form>
  )
}
