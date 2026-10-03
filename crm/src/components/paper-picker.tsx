import { useEffect, useState } from 'react'

import { TextButton } from '#/components/ui/text-button'
import {
  defaultPaperChoice,
  papers,
  pickPaper,
  readStoredPaperChoice,
  showPaper,
  type Paper,
  type PaperChoice,
} from '#/lib/paper'

const paperModes = [
  { mode: 'light', label: 'Papel claro' },
  { mode: 'dark', label: 'Papel oscuro' },
] as const

/**
 * Bottom left, in the margin the conversation leaves free; only from the
 * `picker` breakpoint up, where that margin is wide enough to hold it.
 */
export function PaperPicker() {
  const [choice, setChoice] = useState<PaperChoice>(defaultPaperChoice)

  // The document already carries the stored paper (an inline script in the root
  // applies it before paint); this only catches the controls' labels up.
  useEffect(() => {
    setChoice(readStoredPaperChoice())
  }, [])

  function pick(paper: Paper) {
    const next = pickPaper(choice, paper)
    setChoice(next)
    showPaper(next)
  }

  return (
    <div className="font-meta text-meta uppercase fixed bottom-7.5 left-11 hidden flex-col gap-4 text-ink-mute picker:flex">
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
                <TextButton
                  aria-pressed={picked}
                  className="flex items-center gap-3"
                  key={paper.id}
                  onClick={() => pick(paper)}
                  tone={picked ? 'ink' : 'mute'}
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
                </TextButton>
              )
            })}
        </div>
      ))}
    </div>
  )
}
