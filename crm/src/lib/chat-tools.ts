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
  updateOwnerProfile,
  updatePayment,
  updateService,
} from '#/lib/tools'

import type { InferSchemaType } from '@tanstack/ai'
import type { z } from 'zod'

type ToolRunner = <T>(operation: () => Promise<T>) => Promise<T>

type CrmTool<
  TSchema extends z.ZodType,
  TOutput extends z.ZodType,
  TResult,
> = {
  name: string
  description: string
  inputSchema: TSchema
  outputSchema: TOutput
  execute: (input: z.input<TSchema>) => Promise<TResult>
}

/**
 * A tool result crosses into the model as JSON, so it is made JSON here —
 * before outputSchema validates it. Without this the Dates drizzle hands back
 * would fail the ISO-string fields the schema (and the generated code-mode
 * stub) declares.
 */
function toJson<TResult>(result: TResult) {
  if (result === undefined) return undefined
  // SAFETY: JSON.parse returns exactly what JSON.stringify wrote.
  return JSON.parse(JSON.stringify(result)) as unknown
}

function bindTool<
  TSchema extends z.ZodType,
  TOutput extends z.ZodType,
  TResult,
>(tool: CrmTool<TSchema, TOutput, TResult>, run: ToolRunner) {
  return toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }).server(async (input) => {
    // SAFETY: toolDefinition validates against inputSchema before invoking the server handler, so input matches z.input<TSchema>.
    const result = await run(() => tool.execute(input as z.input<TSchema>))
    // SAFETY: toolDefinition validates the returned JSON against outputSchema before it reaches the model.
    return toJson(result) as InferSchemaType<TOutput>
  })
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
    bindTool(updateOwnerProfile, run),
  ]
}

export const chatTools = createChatTools((operation) => operation())
