import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ProjectEntry } from '@shared/types'
import { formatBytes } from '../lib/format'
import { Icon } from './Icon'

type FileTreeProps = {
  projectPath: string
  onError: (message: string) => void
}

async function fetchDirectory(relativePath: string): Promise<ProjectEntry[]> {
  const result = await window.agentdesk.listProjectDirectory(relativePath)
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.data
}

export function FileTree({ projectPath, onError }: FileTreeProps) {
  const [rootEntries, setRootEntries] = useState<ProjectEntry[] | null>(null)
  const [children, setChildren] = useState<Record<string, ProjectEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    setRootEntries(null)
    setChildren({})
    setExpanded(new Set())
    setLoading(new Set())

    fetchDirectory('')
      .then((entries) => {
        if (!cancelled) {
          setRootEntries(entries)
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRootEntries([])
          onError(error instanceof Error ? error.message : 'Could not read the project tree.')
        }
      })

    return () => {
      cancelled = true
    }
  }, [projectPath])

  async function loadDirectory(relativePath: string): Promise<void> {
    if (children[relativePath]) {
      return
    }
    setLoading((current) => new Set(current).add(relativePath))
    try {
      const entries = await fetchDirectory(relativePath)
      setChildren((current) => ({ ...current, [relativePath]: entries }))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Could not read the folder.')
    } finally {
      setLoading((current) => {
        const next = new Set(current)
        next.delete(relativePath)
        return next
      })
    }
  }

  function toggleDirectory(entry: ProjectEntry): void {
    if (entry.type !== 'dir') {
      return
    }
    const isExpanded = expanded.has(entry.relativePath)
    setExpanded((current) => {
      const next = new Set(current)
      if (isExpanded) {
        next.delete(entry.relativePath)
      } else {
        next.add(entry.relativePath)
      }
      return next
    })
    if (!isExpanded) {
      void loadDirectory(entry.relativePath)
    }
  }

  function renderEntries(entries: ProjectEntry[], depth: number): ReactNode {
    return entries.map((entry) => {
      const isExpanded = expanded.has(entry.relativePath)
      const isLoading = loading.has(entry.relativePath)
      const childEntries = children[entry.relativePath]

      return (
        <div key={entry.relativePath}>
          <button
            className={entry.type === 'dir' ? 'tree-row tree-folder' : 'tree-row tree-file'}
            type="button"
            style={{ paddingLeft: 6 + depth * 14 }}
            title={entry.relativePath}
            onClick={() => toggleDirectory(entry)}
            aria-expanded={entry.type === 'dir' ? isExpanded : undefined}
          >
            <span className="tree-chevron">
              {entry.type === 'dir' && (
                <Icon
                  name="chevron"
                  size={13}
                  className={isExpanded ? 'chevron-open' : undefined}
                />
              )}
            </span>
            <span className="tree-icon">
              <Icon name={entry.type === 'dir' ? 'folder' : 'file'} size={14} />
            </span>
            <span className="tree-name">{entry.name}</span>
            {entry.type === 'file' && entry.size !== null && entry.size > 0 && (
              <span className="tree-size">{formatBytes(entry.size)}</span>
            )}
          </button>
          {entry.type === 'dir' && isExpanded && (
            <div className="tree-children">
              {isLoading ? (
                <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
                  Loading...
                </div>
              ) : childEntries && childEntries.length > 0 ? (
                renderEntries(childEntries, depth + 1)
              ) : (
                <div className="tree-empty" style={{ paddingLeft: 30 + depth * 14 }}>
                  Empty
                </div>
              )}
            </div>
          )}
        </div>
      )
    })
  }

  if (rootEntries === null) {
    return (
      <div className="tree-skeleton" aria-label="Loading project files">
        <span />
        <span />
        <span />
        <span />
      </div>
    )
  }

  if (rootEntries.length === 0) {
    return <p className="tree-empty-state">No source files found.</p>
  }

  return <div className="file-tree">{renderEntries(rootEntries, 0)}</div>
}
