import type { ReactNode } from 'react'

type MessageTextProps = {
  content: string
}

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'rule' }
  | { type: 'code'; content: string; language?: string }

const BLOCK_START = /^(#{1,4}\s|[-*]\s|\d+\.\s|>\s|```|---+\s*$)/

function parseTextBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: heading[2].trim()
      })
      index += 1
      continue
    }

    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    const unordered = /^[-*]\s+(.*)$/.exec(line)
    if (unordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = /^[-*]\s+(.*)$/.exec(lines[index])
        if (!item) {
          break
        }
        items.push(item[1])
        index += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    const ordered = /^\d+\.\s+(.*)$/.exec(line)
    if (ordered) {
      const items: string[] = []
      while (index < lines.length) {
        const item = /^\d+\.\s+(.*)$/.exec(lines[index])
        if (!item) {
          break
        }
        items.push(item[1])
        index += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', text: quoteLines.join('\n') })
      continue
    }

    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !BLOCK_START.test(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    if (paragraph.length === 0) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') })
  }

  return blocks
}

function parseBlocks(content: string): Block[] {
  const blocks: Block[] = []
  const pieces = content.split('```')

  pieces.forEach((piece, index) => {
    if (index % 2 === 1) {
      const newline = piece.indexOf('\n')
      const language = newline >= 0 ? piece.slice(0, newline).trim() : ''
      const code = newline >= 0 ? piece.slice(newline + 1) : piece
      blocks.push({
        type: 'code',
        content: code.replace(/\s+$/, ''),
        language: language || undefined
      })
      return
    }
    blocks.push(...parseTextBlocks(piece))
  })

  return blocks
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  const nodes: ReactNode[] = []
  let cursor = 0
  let match: RegExpExecArray | null

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index))
    }
    const token = match[0]
    if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={`strong-${match.index}`}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={`code-${match.index}`}>{token.slice(1, -1)}</code>)
    } else {
      nodes.push(<em key={`em-${match.index}`}>{token.slice(1, -1)}</em>)
    }
    cursor = match.index + token.length
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor))
  }
  return nodes
}

function headingClass(level: number): string {
  if (level <= 2) {
    return 'message-h message-h1'
  }
  if (level === 3) {
    return 'message-h message-h2'
  }
  return 'message-h message-h3'
}

export function MessageText({ content }: MessageTextProps) {
  const blocks = parseBlocks(content)
  return (
    <div className="message-text">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'code':
            return (
              <div className="message-code" key={`code-${index}`}>
                <div className="message-code-head">
                  <span>{block.language ?? 'code'}</span>
                </div>
                <pre>
                  <code>{block.content}</code>
                </pre>
              </div>
            )
          case 'heading':
            return (
              <div className={headingClass(block.level)} key={`heading-${index}`}>
                {renderInline(block.text)}
              </div>
            )
          case 'list': {
            const List = block.ordered ? 'ol' : 'ul'
            return (
              <List className="message-list" key={`list-${index}`}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${index}-${itemIndex}`}>{renderInline(item)}</li>
                ))}
              </List>
            )
          }
          case 'quote':
            return (
              <blockquote className="message-quote" key={`quote-${index}`}>
                {renderInline(block.text)}
              </blockquote>
            )
          case 'rule':
            return <hr className="message-rule" key={`rule-${index}`} />
          case 'paragraph':
          default:
            return (
              <p className="message-paragraph" key={`paragraph-${index}`}>
                {renderInline(block.text)}
              </p>
            )
        }
      })}
    </div>
  )
}
