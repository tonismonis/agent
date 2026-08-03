import { toolDefinition } from '@tanstack/ai'

import {
  createAppointment,
  createClient,
  createPayment,
  createService,
  findAppointments,
  findClients,
  findPayments,
  findServices,
  listAuditLog,
  restoreAppointment,
  restoreClient,
  restorePayment,
  restoreService,
  softDeleteAppointment,
  softDeleteClient,
  softDeletePayment,
  softDeleteService,
  updateAppointment,
  updateClient,
  updatePayment,
  updateService,
} from '#/lib/tools'

import type { z } from 'zod'

type ToolRunner = <T>(operation: () => Promise<T>) => Promise<T>

type CrmTool<TSchema extends z.ZodType, TResult> = {
  name: string
  description: string
  inputSchema: TSchema
  execute: (input: z.input<TSchema>) => Promise<TResult>
}

function bindTool<TSchema extends z.ZodType, TResult>(
  tool: CrmTool<TSchema, TResult>,
  run: ToolRunner,
) {
  return toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }).server((input) => run(() => tool.execute(input)))
}

export function createChatTools(run: ToolRunner) {
  return [
    bindTool(createClient, run),
    bindTool(findClients, run),
    bindTool(updateClient, run),
    bindTool(softDeleteClient, run),
    bindTool(restoreClient, run),
    bindTool(createService, run),
    bindTool(findServices, run),
    bindTool(updateService, run),
    bindTool(softDeleteService, run),
    bindTool(restoreService, run),
    bindTool(createAppointment, run),
    bindTool(findAppointments, run),
    bindTool(updateAppointment, run),
    bindTool(softDeleteAppointment, run),
    bindTool(restoreAppointment, run),
    bindTool(createPayment, run),
    bindTool(findPayments, run),
    bindTool(updatePayment, run),
    bindTool(softDeletePayment, run),
    bindTool(restorePayment, run),
    bindTool(listAuditLog, run),
  ]
}

export const chatTools = createChatTools((operation) => operation())
