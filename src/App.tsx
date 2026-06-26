import { Prec, type Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { closeSearchPanel, openSearchPanel, searchPanelOpen } from '@codemirror/search'
import { basicSetup, EditorView } from 'codemirror'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'
import {
  joinFilterParts,
  splitForFilter,
  type FilterParts,
} from './domain/filter'
import {
  getRefValueFromLine,
  formatEstimateMinutes,
  isUrlRef,
  normalizeDocumentText,
  shiftTaskDateLine,
  summarizeTodayTasks,
  toggleTaskStartEndLineWithNext,
} from './domain/editaskText'
import { editaskHighlightExtensions } from './editor/editaskExtensions'
import { db, firebaseEnabled } from './firebase/client'
import { deleteFile, ensureFileFromDefault, loadFile, saveFile } from './firebase/fileRepository'
import { useAuthUser } from './hooks/useAuthUser'

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

type CursorRestoreTarget = {
  lineText: string
  column: number
}

type FilterInitialQuery = {
  query: string
  source: 'selection' | 'ref' | 'none'
}

// basicSetup starts with lineNumbers() and highlightActiveLineGutter().
const editaskSetup = (basicSetup as unknown as Extension[]).slice(2)

function fileNameFromHash(): string {
  const match = /^#\/files\/(.+)$/.exec(window.location.hash)
  return match ? decodeURIComponent(match[1]) : 'main'
}

function updateHashFileName(fileName: string) {
  window.history.replaceState(null, '', `#/files/${encodeURIComponent(fileName)}`)
}

function downloadText(fileName: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${fileName || 'editask'}.txt`
  anchor.click()
  URL.revokeObjectURL(url)
}

function findLinePosition(text: string, lineText: string, column: number): number | undefined {
  let offset = 0
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    if (line === lineText) {
      return offset + Math.min(column, line.length)
    }
    offset += line.length + 1
  }
  return undefined
}

function cursorOffsetInScroller(view: EditorView, position: number): number | undefined {
  const cursorRect = view.coordsAtPos(position)
  if (!cursorRect) return undefined
  return cursorRect.top - view.scrollDOM.getBoundingClientRect().top
}

function restoreCursorOffsetInScroller(view: EditorView, position: number, targetOffset: number | undefined) {
  if (targetOffset === undefined) return
  window.requestAnimationFrame(() => {
    const currentOffset = cursorOffsetInScroller(view, position)
    if (currentOffset === undefined) return
    view.scrollDOM.scrollTop += currentOffset - targetOffset
  })
}

function MissingFirebaseScreen() {
  return (
    <main className="login-screen">
      <section className="login-panel">
        <h1>EdiTask</h1>
        <p>Firebase environment variables are missing. Check Web/.env.local.</p>
      </section>
    </main>
  )
}

function LoginScreen() {
  const { signIn, error } = useAuthUser()

  return (
    <main className="login-screen">
      <section className="login-panel">
        <h1>EdiTask</h1>
        <p>Sign in with your Google account to start editing.</p>
        <button type="button" className="primary-button" onClick={signIn}>
          Sign in with Google
        </button>
        {error && <p className="error-text">{error}</p>}
      </section>
    </main>
  )
}

function EditorApp() {
  const { user, signOutUser } = useAuthUser()
  const editorHost = useRef<HTMLDivElement | null>(null)
  const editorView = useRef<EditorView | null>(null)
  const filterInputRef = useRef<HTMLInputElement | null>(null)
  const userRef = useRef(user)
  const fileNameRef = useRef(fileNameFromHash())
  const filterActiveRef = useRef(false)
  const filterOpenRef = useRef(false)
  const skipNextFilterEffectRef = useRef(false)
  const parkedTextRef = useRef('')
  const [fileName, setFileName] = useState(fileNameFromHash)
  const [filterQuery, setFilterQuery] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterActive, setFilterActive] = useState(false)
  const [filterVisibleCount, setFilterVisibleCount] = useState<number | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [todayTaskSummary, setTodayTaskSummary] = useState(() => summarizeTodayTasks(''))

  useEffect(() => {
    userRef.current = user
  }, [user])

  useEffect(() => {
    fileNameRef.current = fileName
    document.title = fileName || 'EdiTask'
  }, [fileName])

  useEffect(() => {
    filterActiveRef.current = filterActive
  }, [filterActive])

  useEffect(() => {
    filterOpenRef.current = filterOpen
  }, [filterOpen])

  const statusLabel = useMemo(() => {
    if (saveState === 'dirty') return 'Unsaved'
    if (saveState === 'saving') return 'Saving'
    if (saveState === 'saved') return 'Saved'
    if (saveState === 'error') return 'Error'
    return 'Idle'
  }, [saveState])

  const loadCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser) return

    try {
      const loaded = await loadFile(db, currentUser.uid, currentFileName)
      parkedTextRef.current = ''
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterActive(false)
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      editorView.current?.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: loaded.content },
      })
      setTodayTaskSummary(summarizeTodayTasks(loaded.content))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const saveCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser || !editorView.current) return

    setSaveState('saving')
    const editorText = editorView.current.state.doc.toString()
    const selectionHead = editorView.current.state.selection.main.head
    const textToSave = filterActiveRef.current
      ? joinFilterParts(parkedTextRef.current, editorText)
      : editorText
    const normalized = normalizeDocumentText(textToSave)

    try {
      await saveFile(db, currentUser.uid, currentFileName, normalized)
      if (filterActiveRef.current) {
      } else {
        const nextSelection = Math.min(selectionHead, normalized.length)
        editorView.current.dispatch({
          changes: { from: 0, to: editorView.current.state.doc.length, insert: normalized },
          selection: { anchor: nextSelection },
          scrollIntoView: true,
        })
      }
      setTodayTaskSummary(summarizeTodayTasks(normalized))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const deleteCurrentFile = useCallback(async () => {
    const currentUser = userRef.current
    const currentFileName = fileNameRef.current
    if (!db || !currentUser || !editorView.current) return

    const confirmed = window.confirm(`Delete "${currentFileName}"? This cannot be undone.`)
    if (!confirmed) return

    setSaveState('saving')
    try {
      await deleteFile(db, currentUser.uid, currentFileName)
      parkedTextRef.current = ''
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterActive(false)
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      editorView.current.dispatch({
        changes: { from: 0, to: editorView.current.state.doc.length, insert: '' },
      })
      setTodayTaskSummary(summarizeTodayTasks(''))
      setSaveState('saved')
    } catch {
      setSaveState('error')
    }
  }, [])

  const applyFilterParts = useCallback((parts: FilterParts, restore?: CursorRestoreTarget) => {
    parkedTextRef.current = parts.parkedText
    filterActiveRef.current = true
    setFilterActive(true)
    setFilterVisibleCount(parts.visibleCount)
    const restorePosition = restore
      ? findLinePosition(parts.visibleText, restore.lineText, restore.column)
      : undefined
    editorView.current?.dispatch({
      changes: {
        from: 0,
        to: editorView.current.state.doc.length,
        insert: parts.visibleText,
      },
      ...(restorePosition !== undefined
        ? { selection: { anchor: restorePosition }, scrollIntoView: true }
        : {}),
    })
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
  }, [])

  const applyFilter = useCallback(
    (query: string) => {
      const view = editorView.current
      if (!view) return
      const baseText = filterActiveRef.current
        ? normalizeDocumentText(joinFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      applyFilterParts(splitForFilter(baseText, query))
    },
    [applyFilterParts],
  )

  const getFilterInitialQuery = useCallback((view: EditorView): FilterInitialQuery => {
    const selectedText = view.state.sliceDoc(
      view.state.selection.main.from,
      view.state.selection.main.to,
    )
    const selectedLine = selectedText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (selectedLine) return { query: selectedLine, source: 'selection' }

    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const ref = getRefValueFromLine(line.text)
    if (!ref || isUrlRef(ref)) return { query: '', source: 'none' }
    return { query: ref.replace(/\.txt$/i, ''), source: 'ref' }
  }, [])

  const closeFilter = useCallback(() => {
    const view = editorView.current
    if (!view) {
      filterActiveRef.current = false
      filterOpenRef.current = false
      setFilterOpen(false)
      setFilterQuery('')
      setFilterActive(false)
      setFilterVisibleCount(null)
      parkedTextRef.current = ''
      return
    }

    if (!filterActiveRef.current) {
      filterOpenRef.current = false
      setFilterOpen(false)
      setFilterQuery('')
      setFilterVisibleCount(null)
      view.focus()
      return
    }

    const currentLine = view.state.doc.lineAt(view.state.selection.main.head)
    const restoreLineText = currentLine.text
    const restoreColumn = view.state.selection.main.head - currentLine.from
    const restoreOffset = cursorOffsetInScroller(view, view.state.selection.main.head)
    const fullText = filterActiveRef.current
      ? joinFilterParts(parkedTextRef.current, view.state.doc.toString())
      : view.state.doc.toString()
    const normalized = normalizeDocumentText(fullText)
    const restorePosition = findLinePosition(normalized, restoreLineText, restoreColumn) ?? 0
    parkedTextRef.current = ''
    filterActiveRef.current = false
    filterOpenRef.current = false
    setFilterOpen(false)
    setFilterQuery('')
    setFilterActive(false)
    setFilterVisibleCount(null)
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: normalized },
      selection: { anchor: restorePosition },
      scrollIntoView: true,
    })
    restoreCursorOffsetInScroller(view, restorePosition, restoreOffset)
    setSaveState((state) => (state === 'saving' ? state : 'dirty'))
    view.focus()
  }, [])

  const openFilter = useCallback(() => {
    const view = editorView.current
    const initialQuery = view ? getFilterInitialQuery(view) : { query: '', source: 'none' as const }
    const currentLine = view?.state.doc.lineAt(view.state.selection.main.head)
    const restore = view && currentLine
      ? {
          lineText: currentLine.text,
          column: view.state.selection.main.head - currentLine.from,
        }
      : undefined
    filterOpenRef.current = true
    setFilterOpen(true)
    if (initialQuery.query && view) {
      setFilterQuery(initialQuery.query)
      const baseText = filterActiveRef.current
        ? normalizeDocumentText(joinFilterParts(parkedTextRef.current, view.state.doc.toString()))
        : view.state.doc.toString()
      skipNextFilterEffectRef.current = true
      applyFilterParts(splitForFilter(baseText, initialQuery.query), restore)
    } else {
      setFilterQuery('')
    }
    window.setTimeout(() => {
      if (initialQuery.source === 'ref') {
        view?.focus()
        return
      }
      filterInputRef.current?.focus()
      filterInputRef.current?.select()
    }, 0)
  }, [applyFilterParts, getFilterInitialQuery])

  const toggleFilter = useCallback(() => {
    if (filterOpenRef.current) {
      closeFilter()
    } else {
      openFilter()
    }
    return true
  }, [closeFilter, openFilter])

  const toggleSearchPanel = useCallback((view: EditorView) => {
    if (searchPanelOpen(view.state)) {
      return closeSearchPanel(view)
    }
    return openSearchPanel(view)
  }, [])

  const toggleCurrentLineStartEnd = useCallback((view: EditorView) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const result = toggleTaskStartEndLineWithNext(line.text)
    if (result.line === line.text && !result.nextLine) return true

    const changes = [{ from: line.from, to: line.to, insert: result.line }]
    if (result.nextLine) {
      const docText = view.state.doc.toString()
      changes.push({
        from: view.state.doc.length,
        to: view.state.doc.length,
        insert: `${docText.endsWith('\n') || docText.length === 0 ? '' : '\n'}${result.nextLine}`,
      })
    }

    view.dispatch({
      changes,
      selection: { anchor: line.from + Math.min(result.line.length, view.state.selection.main.head - line.from) },
    })
    return true
  }, [])

  const shiftSelectedTaskDates = useCallback((view: EditorView, deltaDays: number) => {
    const lineNumbers = new Set<number>()
    for (const range of view.state.selection.ranges) {
      if (range.empty) {
        lineNumbers.add(view.state.doc.lineAt(range.head).number)
        continue
      }

      const from = Math.min(range.from, range.to)
      const to = Math.max(range.from, range.to)
      const firstLine = view.state.doc.lineAt(from).number
      const lastLine = view.state.doc.lineAt(Math.max(from, to - 1)).number
      for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber += 1) {
        lineNumbers.add(lineNumber)
      }
    }

    const changes = [...lineNumbers]
      .sort((a, b) => a - b)
      .flatMap((lineNumber) => {
        const line = view.state.doc.line(lineNumber)
        const result = shiftTaskDateLine(line.text, deltaDays)
        return result.changed ? [{ from: line.from, to: line.to, insert: result.line }] : []
      })

    if (changes.length === 0) return true
    view.dispatch({ changes })
    return true
  }, [])

  const openRef = useCallback(async () => {
    const view = editorView.current
    if (!view) return

    const line = view.state.doc.lineAt(view.state.selection.main.head)
    const ref = getRefValueFromLine(line.text)
    if (!ref) {
      window.alert('ref not found')
      return
    }

    if (isUrlRef(ref)) {
      window.open(ref, '_blank', 'noopener,noreferrer')
      return
    }

    const nextName = ref.replace(/\.txt$/i, '') || 'main'
    const currentUser = userRef.current
    if (db && currentUser) {
      try {
        await ensureFileFromDefault(db, currentUser.uid, nextName)
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Failed to create ref file')
        return
      }
    }
    const url = `${window.location.origin}${window.location.pathname}#/files/${encodeURIComponent(nextName)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [])

  const exportCurrentFile = useCallback(() => {
    downloadText(fileNameRef.current, editorView.current?.state.doc.toString() ?? '')
  }, [])

  useEffect(() => {
    updateHashFileName(fileName)
  }, [fileName])

  useEffect(() => {
    void loadCurrentFile()
  }, [fileName, loadCurrentFile, user])

  useEffect(() => {
    if (!filterOpen) return undefined
    if (skipNextFilterEffectRef.current) {
      skipNextFilterEffectRef.current = false
      return undefined
    }
    if (!filterQuery.trim() && !filterActiveRef.current) {
      setFilterVisibleCount(null)
      return undefined
    }
    const timer = window.setTimeout(() => {
      applyFilter(filterQuery)
    }, 350)
    return () => window.clearTimeout(timer)
  }, [applyFilter, filterOpen, filterQuery])

  useEffect(() => {
    if (!editorHost.current || editorView.current) return undefined

    editorView.current = new EditorView({
      parent: editorHost.current,
      doc: '',
      extensions: [
        editaskSetup,
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-f',
              run: toggleSearchPanel,
              preventDefault: true,
              scope: 'editor search-panel',
            },
            {
              key: 'Mod-h',
              run: toggleSearchPanel,
              preventDefault: true,
              scope: 'editor search-panel',
            },
            {
              key: 'Mod-Shift-f',
              run: toggleFilter,
              preventDefault: true,
            },
            {
              key: 'Mod-q',
              run: toggleCurrentLineStartEnd,
              preventDefault: true,
            },
            {
              key: 'Mod-Shift-ArrowUp',
              run: (view) => shiftSelectedTaskDates(view, -1),
              preventDefault: true,
            },
            {
              key: 'Mod-Shift-ArrowDown',
              run: (view) => shiftSelectedTaskDates(view, 1),
              preventDefault: true,
            },
          ]),
        ),
        editaskHighlightExtensions,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            if (filterActiveRef.current) {
              setFilterVisibleCount(update.state.doc.length > 0 ? update.state.doc.lines : 0)
            }
            setSaveState((state) => (state === 'saving' ? state : 'dirty'))
          }
        }),
        EditorView.domEventHandlers({
          keydown(event) {
            if (event.ctrlKey && event.key.toLowerCase() === 's') {
              event.preventDefault()
              void saveCurrentFile()
              return true
            }
            if (event.ctrlKey && event.key.toLowerCase() === 'r') {
              event.preventDefault()
              void openRef()
              return true
            }
            if (event.key === 'Escape' && filterOpenRef.current) {
              event.preventDefault()
              closeFilter()
              return true
            }
            return false
          },
        }),
      ],
    })

    return () => {
      editorView.current?.destroy()
      editorView.current = null
    }
  }, [
    closeFilter,
    openRef,
    saveCurrentFile,
    shiftSelectedTaskDates,
    toggleCurrentLineStartEnd,
    toggleFilter,
    toggleSearchPanel,
  ])

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="file-controls">
          <img
            className="app-icon"
            src={`${import.meta.env.BASE_URL}favicon-32x32.png`}
            alt=""
            aria-hidden="true"
          />
          <input
            className="file-name-input"
            value={fileName}
            onChange={(event) => setFileName(event.target.value.trim() || 'main')}
            onBlur={() => void loadCurrentFile()}
            aria-label="File name"
          />
          <span className={`save-state save-state-${saveState}`}>{statusLabel}</span>
        </div>
        <div className="session-controls">
          <span className="user-label">{user?.displayName ?? user?.email}</span>
          <button type="button" onClick={exportCurrentFile}>
            Export
          </button>
          <button type="button" className="danger-button" onClick={() => void deleteCurrentFile()}>
            Delete
          </button>
          <button type="button" onClick={() => void signOutUser()}>
            Logout
          </button>
        </div>
      </header>

      {filterOpen && (
        <section className="filter-bar">
          <label htmlFor="filter-input">Filter</label>
          <input
            id="filter-input"
            ref={filterInputRef}
            value={filterQuery}
            onChange={(event) => setFilterQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'f') {
                event.preventDefault()
                closeFilter()
                return
              }
              if (event.key === 'Escape') {
                closeFilter()
              }
            }}
            placeholder="Search"
          />
          <span>
            {filterActive
              ? `${filterVisibleCount ?? 0} visible lines`
              : 'Type to filter lines'}
          </span>
          <button
            type="button"
            onClick={() => {
              closeFilter()
            }}
          >
            Close
          </button>
        </section>
      )}

      <section className="workspace">
        <div className="editor-pane" ref={editorHost} />
      </section>

      <footer className="statusbar">
        <span>
          {'\u4eca\u65e5: '}{todayTaskSummary.remaining}{' \u5b8c\u4e86: '}{todayTaskSummary.completed}{' \u4f5c\u696d\u4e88\u6e2c: '}
          {formatEstimateMinutes(todayTaskSummary.estimatedMinutes)}
        </span>
        <span>Ctrl+S Save / Ctrl+F Find / Ctrl+Shift+F Filter / Ctrl+Shift+Up/Down Date / Ctrl+R ref</span>
      </footer>
    </main>
  )
}

function App() {
  const authState = useAuthUser()

  if (!firebaseEnabled) return <MissingFirebaseScreen />
  if (authState.loading) return <main className="login-screen">Loading...</main>
  if (!authState.user) return <LoginScreen />
  return <EditorApp />
}

export default App
