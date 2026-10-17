import type { FastifyReply } from 'fastify'

export const sendError = (reply: FastifyReply, status: number, code: string, message: string) =>
  reply.code(status).send({ message, code })
