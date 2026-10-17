interface MessageQueueOptions {
  isOpen: () => boolean
  transform: (data: string) => Promise<string>
  handle: (data: string) => void
  onError: (error: unknown) => void
}

/** Keep asynchronous frame codecs in wire order, including their dispatch. */
export const createMessageQueue = ({ isOpen, transform, handle, onError }: MessageQueueOptions) => {
  let pending = Promise.resolve()
  return (data: string): Promise<void> => {
    pending = pending.then(async() => {
      if (!isOpen()) return
      const transformed = await transform(data)
      // A socket can close while gzip/gunzip is still running.
      if (isOpen()) handle(transformed)
    }).catch(onError)
    return pending
  }
}
