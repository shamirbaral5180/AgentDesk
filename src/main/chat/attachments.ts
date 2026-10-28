import { randomUUID, createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { BrowserWindow, dialog, nativeImage } from 'electron'
import type { ChatAttachment } from '@shared/types'
import { AppError } from '../errors'
import {
  getCurrentProjectDatabase,
  getCurrentProjectRoot
} from '../project/projectService'
import {
  ensureDir,
  isPathInside,
  safeJoin,
  toPortablePath
} from '../utils/fs'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES_PER_MESSAGE = 4
const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

type AttachmentRow = {
  id: string
  message_id: string | null
  path: string
  mime: string
  size: number
  sha256: string
  width: number | null
  height: number | null
  caption: string | null
  created_at: number
}

export type AttachmentRecord = AttachmentRow & {
  absolutePath: string
  name: string
}

function sniffMime(buffer: Buffer): string | null {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'image/png'
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 4).toString('ascii') === 'GIF8'
  ) {
    return 'image/gif'
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp'
  }
  return null
}

function imageDimensions(buffer: Buffer): { width?: number; height?: number } {
  try {
    const image = nativeImage.createFromBuffer(buffer)
    if (!image.isEmpty()) {
      const size = image.getSize()
      return { width: size.width, height: size.height }
    }
  } catch {
    return {}
  }
  return {}
}

function dataUrlForFile(filePath: string, mime: string): string {
  const buffer = fs.readFileSync(filePath)
  return `data:${mime};base64,${buffer.toString('base64')}`
}

function projectRoot(): string {
  const root = getCurrentProjectRoot()
  if (!root) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return root
}

function database() {
  const projectDatabase = getCurrentProjectDatabase()
  if (!projectDatabase) {
    throw new AppError('NO_PROJECT', 'No project is currently open.')
  }
  return projectDatabase.db
}

function toChatAttachment(
  row: AttachmentRow,
  root: string,
  includeDataUrl: boolean
): ChatAttachment {
  const absolutePath = safeJoin(root, row.path)
  return {
    id: row.id,
    name: row.caption ?? path.basename(row.path),
    mime: row.mime,
    size: row.size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    dataUrl:
      includeDataUrl && fs.existsSync(absolutePath)
        ? dataUrlForFile(absolutePath, row.mime)
        : undefined
  }
}

export function createImageAttachmentFromBuffer(input: {
  buffer: Buffer
  originalName: string
}): ChatAttachment {
  const root = projectRoot()
  const mime = sniffMime(input.buffer)
  if (!mime) {
    throw new AppError(
      'UNSUPPORTED_IMAGE',
      'Only PNG, JPEG, WebP, and GIF images are supported.'
    )
  }
  if (input.buffer.length > MAX_IMAGE_BYTES) {
    throw new AppError(
      'IMAGE_TOO_LARGE',
      `Images must be smaller than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`
    )
  }

  const extension = IMAGE_EXTENSIONS[mime]
  const sha256 = createHash('sha256').update(input.buffer).digest('hex')
  const relativePath = `.agentdesk/assets/attachments/${sha256}.${extension}`
  const absolutePath = safeJoin(root, relativePath)
  ensureDir(path.dirname(absolutePath))
  if (!fs.existsSync(absolutePath)) {
    fs.writeFileSync(absolutePath, input.buffer)
  }

  const dimensions = imageDimensions(input.buffer)
  const id = randomUUID()
  const createdAt = Date.now()
  const originalName = path.basename(input.originalName) || `image.${extension}`
  database()
    .prepare(
      `INSERT INTO attachments (id, message_id, path, mime, size, sha256, width, height, caption, created_at)
       VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      relativePath,
      mime,
      input.buffer.length,
      sha256,
      dimensions.width ?? null,
      dimensions.height ?? null,
      originalName,
      createdAt
    )

  return {
    id,
    name: originalName,
    mime,
    size: input.buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    dataUrl: dataUrlForFile(absolutePath, mime)
  }
}

export function createImageAttachment(filePath: string): ChatAttachment {
  projectRoot()
  if (!fs.existsSync(filePath)) {
    throw new AppError('IMAGE_NOT_FOUND', 'The selected image could not be found.')
  }
  let buffer: Buffer
  try {
    buffer = fs.readFileSync(filePath)
  } catch (error) {
    throw new AppError(
      'IMAGE_READ_FAILED',
      'The selected image could not be read.',
      error instanceof Error ? error.message : undefined
    )
  }
  return createImageAttachmentFromBuffer({
    buffer,
    originalName: path.basename(filePath)
  })
}

export async function pickChatImages(): Promise<ChatAttachment[]> {
  const window = BrowserWindow.getFocusedWindow()
  const options: Electron.OpenDialogOptions = {
    title: 'Attach images',
    buttonLabel: 'Attach',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: 'Images',
        extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif']
      }
    ]
  }
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) {
    return []
  }
  const selected = result.filePaths.slice(0, MAX_IMAGES_PER_MESSAGE)
  return selected.map((filePath) => createImageAttachment(filePath))
}

export function getAttachmentRecords(ids: string[]): AttachmentRecord[] {
  if (ids.length === 0) {
    return []
  }
  const root = projectRoot()
  const placeholders = ids.map(() => '?').join(',')
  const rows = database()
    .prepare(`SELECT * FROM attachments WHERE id IN (${placeholders})`)
    .all(...ids) as AttachmentRow[]
  const byId = new Map(rows.map((row) => [row.id, row]))
  const records: AttachmentRecord[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row) {
      throw new AppError(
        'ATTACHMENT_NOT_FOUND',
        'One of the attached images is no longer available.'
      )
    }
    if (row.message_id) {
      throw new AppError(
        'ATTACHMENT_ALREADY_USED',
        'One of the attached images has already been sent.'
      )
    }
    const absolutePath = safeJoin(root, row.path)
    if (!fs.existsSync(absolutePath)) {
      throw new AppError(
        'ATTACHMENT_MISSING',
        'One of the attached images is missing from the project assets folder.'
      )
    }
    const realPath = fs.realpathSync(absolutePath)
    if (!isPathInside(root, realPath)) {
      throw new AppError('ATTACHMENT_INVALID', 'An attachment path escaped the project.')
    }
    records.push({
      ...row,
      name: row.caption ?? path.basename(row.path),
      absolutePath
    })
  }
  return records
}

export function getAttachmentsForMessages(
  messageIds: string[],
  includeDataUrl = true
): Map<string, ChatAttachment[]> {
  const result = new Map<string, ChatAttachment[]>()
  if (messageIds.length === 0) {
    return result
  }
  const root = projectRoot()
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = database()
    .prepare(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
    )
    .all(...messageIds) as AttachmentRow[]

  for (const row of rows) {
    if (!row.message_id) {
      continue
    }
    const list = result.get(row.message_id) ?? []
    list.push(toChatAttachment(row, root, includeDataUrl))
    result.set(row.message_id, list)
  }
  return result
}

export function bindAttachmentsToMessage(messageId: string, attachmentIds: string[]): void {
  if (attachmentIds.length === 0) {
    return
  }
  const statement = database().prepare(
    'UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL'
  )
  for (const id of attachmentIds) {
    const result = statement.run(messageId, id)
    if (result.changes !== 1) {
      throw new AppError(
        'ATTACHMENT_BIND_FAILED',
        'One of the attached images could not be linked to the message.'
      )
    }
  }
}

export function readImagePart(record: AttachmentRecord): {
  mediaType: string
  data: Uint8Array
} {
  const data = fs.readFileSync(record.absolutePath)
  return {
    mediaType: record.mime,
    data
  }
}

export function getImagePartsForMessages(
  messageIds: string[]
): Map<string, Array<{ mediaType: string; data: Uint8Array }>> {
  const result = new Map<string, Array<{ mediaType: string; data: Uint8Array }>>()
  if (messageIds.length === 0) {
    return result
  }
  const root = projectRoot()
  const placeholders = messageIds.map(() => '?').join(',')
  const rows = database()
    .prepare(
      `SELECT * FROM attachments WHERE message_id IN (${placeholders}) ORDER BY created_at ASC`
    )
    .all(...messageIds) as AttachmentRow[]
  for (const row of rows) {
    if (!row.message_id) {
      continue
    }
    const absolutePath = safeJoin(root, row.path)
    if (!fs.existsSync(absolutePath)) {
      continue
    }
    const list = result.get(row.message_id) ?? []
    list.push({
      mediaType: row.mime,
      data: fs.readFileSync(absolutePath)
    })
    result.set(row.message_id, list)
  }
  return result
}

export function attachmentCountForMessage(messageId: string): number {
  const row = database()
    .prepare('SELECT COUNT(*) AS count FROM attachments WHERE message_id = ?')
    .get(messageId) as { count: number } | undefined
  return row?.count ?? 0
}

export function attachmentPathForTest(attachment: ChatAttachment): string {
  const root = projectRoot()
  const row = database()
    .prepare('SELECT path FROM attachments WHERE id = ?')
    .get(attachment.id) as { path?: string } | undefined
  if (!row?.path) {
    throw new AppError('ATTACHMENT_NOT_FOUND', 'Attachment not found.')
  }
  return toPortablePath(root, safeJoin(root, row.path))
}



