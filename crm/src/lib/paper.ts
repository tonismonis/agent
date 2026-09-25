/**
 * The papers the chat can be read on. The Owner picks a mode, and per mode one
 * paper; the pick is kept per device. Colors live in styles.css, one
 * [data-paper] block per id here.
 */
import { isJsonObject, isJsonString, type JsonObject, type JsonValue } from '#/lib/json'

export const papers = [
  { id: 'hueso', name: 'Hueso', mode: 'light' },
  { id: 'greige', name: 'Greige', mode: 'light' },
  { id: 'pizarra', name: 'Pizarra', mode: 'dark' },
  { id: 'indigo', name: 'Índigo', mode: 'dark' },
] as const

export type Paper = (typeof papers)[number]
type PaperIn<M extends PaperMode> = Extract<Paper, { mode: M }>

export type PaperMode = 'light' | 'dark'
export type PaperId = Paper['id']
export type PaperChoice = {
  mode: PaperMode
  light: PaperIn<'light'>['id']
  dark: PaperIn<'dark'>['id']
}

export const defaultPaperChoice: PaperChoice = {
  mode: 'dark',
  light: 'hueso',
  dark: 'pizarra',
}

export const paperStorageKey = 'libreta-paper'

function papersIn<M extends PaperMode>(mode: M) {
  return papers.filter((paper): paper is PaperIn<M> => paper.mode === mode)
}

function paperIn<M extends PaperMode>(mode: M, id: JsonValue | undefined) {
  if (!isJsonString(id)) return undefined
  return papersIn(mode).find((paper) => paper.id === id)
}

function parseJson(text: string | null) {
  if (text === null) return undefined
  try {
    // SAFETY: JSON.parse only ever yields JSON.
    return JSON.parse(text) as JsonValue
  } catch {
    return undefined
  }
}

/** A stored choice, each field falling back to the default on its own. */
export function readPaperChoice(stored: string | null): PaperChoice {
  const value = parseJson(stored)
  const fields: JsonObject = isJsonObject(value) ? value : {}
  return {
    mode:
      fields.mode === 'light' || fields.mode === 'dark'
        ? fields.mode
        : defaultPaperChoice.mode,
    light: paperIn('light', fields.light)?.id ?? defaultPaperChoice.light,
    dark: paperIn('dark', fields.dark)?.id ?? defaultPaperChoice.dark,
  }
}

/** Picking a paper also shows it, so it brings its mode along. */
export function pickPaper(choice: PaperChoice, paper: Paper): PaperChoice {
  return paper.mode === 'light'
    ? { ...choice, mode: 'light', light: paper.id }
    : { ...choice, mode: 'dark', dark: paper.id }
}

export function showPaper(choice: PaperChoice) {
  document.documentElement.dataset.paper = choice[choice.mode]
  try {
    window.localStorage.setItem(paperStorageKey, JSON.stringify(choice))
  } catch {
    /* storage blocked: the pick still shows for this page */
  }
}

/**
 * readPaperChoice for the root document, run before first paint so a stored
 * light paper never flashes dark. Built from the registry, so an id added
 * above is valid here too.
 */
export const paperScript = `try{var c=JSON.parse(localStorage.getItem(${JSON.stringify(paperStorageKey)})),d=${JSON.stringify(defaultPaperChoice)},ids=${JSON.stringify({ light: papersIn('light').map((paper) => paper.id), dark: papersIn('dark').map((paper) => paper.id) })},m=c.mode==='light'||c.mode==='dark'?c.mode:d.mode;document.documentElement.dataset.paper=ids[m].indexOf(c[m])<0?d[m]:c[m]}catch(e){}`
