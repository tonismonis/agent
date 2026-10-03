/**
 * Design preview: ChatView rendered from fixtures, no auth, no model. Local
 * only — its own Vite config and port; the app build never references it.
 *
 *   /?state=queued&paper=hueso&work=off
 */
import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'

import { ChatView, workStorageKey } from '#/routes/-chat/chat-view'
import { papers, pickPaper, readStoredPaperChoice, showPaper } from '#/lib/paper'
import { states, type ChatState, type StateName } from './fixtures'

import './styles.css'

const params = new URLSearchParams(window.location.search)
const stateName = params.get('state')
const paperId = params.get('paper')
const work = params.get('work')

// ChatView reads its paper and work-margin preferences from storage on mount.
function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* storage blocked: the view keeps its defaults */
  }
}

// The app's root script shows the stored paper before paint; this page has
// none, so it does the same here, before render.
const choice = readStoredPaperChoice()
const paper = papers.find((entry) => entry.id === paperId)
showPaper(paper ? pickPaper(choice, paper) : choice)
if (work === 'on' || work === 'off') store(workStorageKey, work)

function isStateName(name: string | null): name is StateName {
  return name !== null && Object.hasOwn(states, name)
}

function Preview({ name }: { name: StateName }) {
  const [state, setState] = useState<ChatState>(states[name])
  const [input, setInput] = useState('')

  return (
    <ChatView
      {...state}
      input={input}
      onCancelQueued={(queuedId) =>
        setState((current) => ({
          ...current,
          queue: current.queue.filter((item) => item.id !== queuedId),
        }))
      }
      onInputChange={setInput}
      onStop={() => setState((current) => ({ ...current, isLoading: false }))}
      onSubmit={() => {
        const text = input.trim()
        if (!text) return
        setInput('')
        setState((current) => ({
          ...current,
          messages: [
            ...current.messages,
            {
              id: `sent-${current.messages.length}`,
              role: 'user',
              parts: [{ type: 'text', content: text }],
            },
          ],
        }))
      }}
    />
  )
}

function Index() {
  return (
    <main className="min-h-screen bg-ground p-11 font-meta text-[12px] text-ink-mute">
      <p className="mb-6 uppercase tracking-[0.16em]">Chat states</p>
      <ul className="flex flex-col gap-2">
        {Object.keys(states).map((name) => (
          <li key={name}>
            <a className="text-ink hover:underline" href={`?state=${name}`}>
              {name}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-8">Add &amp;paper=hueso or &amp;work=off to any state.</p>
    </main>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      {isStateName(stateName) ? <Preview name={stateName} /> : <Index />}
    </StrictMode>,
  )
}
