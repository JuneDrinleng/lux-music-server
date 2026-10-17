import fs from 'node:fs'
import path from 'node:path'

type Message = LX.Sync.Together.ChatMessage

/** Single-process, append-only room logs. No retention cleanup, including closed rooms. */
export class ChatStore {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly directory = path.join(global.lx.dataPath, 'lux', 'together-chat')) {}

  private filename(roomId: string) {
    // Hex is injective and cannot contain path separators (including for non-UUID input).
    return path.join(this.directory, `${Buffer.from(roomId).toString('hex')}.jsonl`)
  }

  /** Read backward in bounded chunks; only newline-terminated records are committed. */
  private *messages(roomId: string): Generator<Message> {
    let fd: number
    try { fd = fs.openSync(this.filename(roomId), 'r') } catch (error) {
      if ((error as NodeJS.ErrnoException).code == 'ENOENT') return
      throw error
    }
    try {
      let position = fs.fstatSync(fd).size
      let rest = Buffer.alloc(0)
      let tail = true
      while (position > 0) {
        const size = Math.min(position, 8192)
        position -= size
        const chunk = Buffer.alloc(size)
        fs.readSync(fd, chunk, 0, size, position)
        rest = Buffer.concat([chunk, rest])
        let end = rest.length
        for (let i = rest.length - 1; i >= 0; i--) {
          if (rest[i] != 10) continue
          if (!tail) {
            const line = rest.subarray(i + 1, end).toString('utf8')
            try {
              const message = JSON.parse(line) as Message
              if (message.roomId == roomId && Number.isSafeInteger(message.id) && message.id > 0) yield message
            } catch {} // A torn record isolated by the next append is also ignored.
          }
          tail = false
          end = i
        }
        rest = rest.subarray(0, end)
      }
      if (!tail && rest.length) {
        try {
          const message = JSON.parse(rest.toString('utf8')) as Message
          if (message.roomId == roomId && Number.isSafeInteger(message.id) && message.id > 0) yield message
        } catch {}
      }
    } finally { fs.closeSync(fd) }
  }

  history(roomId: string, beforeId = Infinity, limit = 50): LX.Sync.Together.ChatPage {
    const messages: Message[] = []
    for (const message of this.messages(roomId)) {
      if (message.id >= beforeId) continue
      if (messages.length == limit) return { messages, hasMore: true }
      messages.push(message)
    }
    return { messages, hasMore: false }
  }

  append(input: Omit<Message, 'id'>, accept: (created: boolean) => boolean = () => true) {
    const previous = this.queues.get(input.roomId) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async() => {
      let lastId = 0
      for (const message of this.messages(input.roomId)) {
        lastId = Math.max(lastId, message.id)
        if (message.senderId == input.senderId && message.clientMsgId == input.clientMsgId) {
          return accept(false) ? { message, created: false } : null
        }
      }
      if (!accept(true)) return null
      if (lastId >= Number.MAX_SAFE_INTEGER) throw new Error('Chat message id exhausted')
      const message: Message = { ...input, id: lastId + 1 }
      await fs.promises.mkdir(this.directory, { recursive: true })
      const file = await fs.promises.open(this.filename(input.roomId), 'a+', 0o600)
      try {
        const size = (await file.stat()).size
        const last = Buffer.alloc(1)
        if (size) await file.read(last, 0, 1, size - 1)
        // Isolate a torn suffix without rewriting the append-only log.
        await file.appendFile(`${size && last[0] != 10 ? '\0\n' : ''}${JSON.stringify(message)}\n`, 'utf8')
        await file.sync()
      } finally { await file.close() }
      const directory = await fs.promises.open(this.directory, 'r')
      try { await directory.sync() } catch (error) {
        if (!['EINVAL', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      } finally { await directory.close() }
      return { message, created: true }
    })
    this.queues.set(input.roomId, pending)
    void pending.finally(() => {
      if (this.queues.get(input.roomId) === pending) this.queues.delete(input.roomId)
    }).catch(() => {})
    return pending
  }
}
