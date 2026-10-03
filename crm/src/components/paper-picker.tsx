import { useEffect, useState } from 'react'

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
 * Bottom left, in the margin the conversation leaves free; only where that
 * margin is wide enough to hold it ((1200 − 816) / 2 = 192px).
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
    <div className="fixed bottom-[30px] left-11 hidden flex-col gap-4 font-meta text-[10px] uppercase tracking-[0.16em] text-ink-mute min-[1200px]:flex">
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
                <button
                  aria-pressed={picked}
                  className={`flex cursor-pointer items-center gap-3 uppercase tracking-[0.16em] hover:text-ink ${picked ? 'text-ink' : ''}`}
                  key={paper.id}
                  onClick={() => pick(paper)}
                  type="button"
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
                </button>
              )
            })}
        </div>
      ))}
    </div>
  )
}
