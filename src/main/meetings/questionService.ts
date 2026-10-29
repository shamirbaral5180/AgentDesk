import type { WebContents } from 'electron'
import { IPC_CHANNELS, type MeetingQuestion } from '@shared/types'
import { createLogger } from '../config/logger'
import { AppError } from '../errors'
import {
  answerMeetingQuestionRecord,
  cancelMeetingQuestions,
  createMeetingQuestion,
  meetingSummary
} from './meetingStore'

const log = createLogger('questions')

type PendingQuestion = {
  meetingId: string
  resolve: (answer: string) => void
  reject: (error: unknown) => void
}

const pending = new Map<string, PendingQuestion>()

function emit(sender: WebContents, type: 'question' | 'question-answered', question: MeetingQuestion): void {
  if (sender.isDestroyed()) {
    return
  }
  sender.send(IPC_CHANNELS.meetingEvent, {
    type,
    meetingId: question.meetingId,
    question,
    meeting: meetingSummary(question.meetingId)
  })
}

export function askMeetingQuestion(
  sender: WebContents,
  input: {
    meetingId: string
    taskId?: string | null
    agentId: string
    question: string
    options: string[]
  }
): Promise<string> {
  const cleanOptions = input.options.map((option) => option.trim()).filter(Boolean).slice(0, 6)
  if (cleanOptions.length < 2) {
    throw new AppError('QUESTION_OPTIONS_REQUIRED', 'A question needs at least two options.')
  }
  const record = createMeetingQuestion({
    meetingId: input.meetingId,
    taskId: input.taskId ?? null,
    agentId: input.agentId,
    question: input.question.trim(),
    options: cleanOptions
  })
  emit(sender, 'question', record)
  log.info('Question asked', {
    questionId: record.id,
    meetingId: input.meetingId,
    agentId: input.agentId
  })
  return new Promise<string>((resolve, reject) => {
    pending.set(record.id, { meetingId: input.meetingId, resolve, reject })
  })
}

export function answerMeetingQuestion(input: {
  meetingId: string
  questionId: string
  answer: string
}): MeetingQuestion {
  const record = answerMeetingQuestionRecord(input)
  const entry = pending.get(input.questionId)
  if (entry) {
    pending.delete(input.questionId)
    entry.resolve(record.answer ?? input.answer)
  }
  return record
}

export function cancelQuestionsForMeeting(meetingId: string, reason: string): void {
  cancelMeetingQuestions(meetingId, reason)
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.meetingId !== meetingId) {
      continue
    }
    pending.delete(id)
    entry.reject(new AppError('QUESTION_CANCELLED', reason))
  }
}

export function cancelAllQuestions(reason = 'The project was closed.'): void {
  for (const [id, entry] of [...pending.entries()]) {
    pending.delete(id)
    entry.reject(new AppError('QUESTION_CANCELLED', reason))
  }
}

export function pendingQuestionCount(): number {
  return pending.size
}
