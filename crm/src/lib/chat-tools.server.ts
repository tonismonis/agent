import { convertSchemaToJsonSchema, toolDefinition } from '@tanstack/ai'

import type { JsonValue } from '#/lib/json'
import { RefusalError, refuse } from '#/lib/refusal'

import {
  createAppointment,
  createAppointmentSeries,
  createClient,
  createPayment,
  createService,
  findAppointmentSeries,
  findAppointments,
  findClients,
  findPayments,
  findServices,
  findWriteSubject,
  listAuditLog,
  restoreAppointment,
  restoreAppointmentSeries,
  restoreClient,
  restorePayment,
  restoreService,
  softDeleteAppointment,
  softDeleteAppointmentSeries,
  softDeleteClient,
  softDeletePayment,
  softDeleteService,
  updateAppointment,
  updateAppointmentSeries,
  updateClient,
  updateOwnerProfile,
  updatePayment,
  updateService,
  type CrmTool,
} from '#/lib/tools.server'
import { classifyRefusal, lookupWriteTool, writeEventName } from '#/lib/receipt-facts'
import { isWriteTool } from '#/lib/write-receipts'

import type { z } from 'zod'

type ToolRunner = <T>(operation: () => Promise<T>) => Promise<T>

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

/**
 * The bridge boundary. The library gets plain JSON Schemas, which its binding
 * passes through without validating, so every failure (invalid input
 * included) reaches the tool and comes back as a refusal. Output is validated
 * here instead; a mismatch is our bug.
 */
export function bindTool<
  TSchema extends z.ZodType,
  TOutput extends z.ZodType,
  TResult,
>(tool: CrmTool<TSchema, TOutput, TResult>, run: ToolRunner) {
  const write = isWriteTool(tool.name)
  return toolDefinition({
    name: tool.name,
    description: tool.description,
    inputSchema: convertSchemaToJsonSchema(tool.inputSchema),
    outputSchema: convertSchemaToJsonSchema(tool.outputSchema),
  }).server(async (input, context) => {
    let result: TResult
    try {
      // SAFETY: execute parses its raw input itself and refuses anything else.
      result = await run(() => tool.execute(input as z.input<TSchema>))
    } catch (error) {
      if (!(error instanceof RefusalError))
        console.error('tool failed outside its transaction', tool.name, error)
      const refusal = error instanceof RefusalError ? error : refuse.internal(write)
      const reason = classifyRefusal(refusal.refusal.kind)
      const writeTool = lookupWriteTool(tool.name)
      if (reason && writeTool)
        context?.emitCustomEvent(writeEventName, {
          status: 'refused',
          name: tool.name,
          args: input,
          reason,
          subject: await run(() =>
            // SAFETY: a tool input is the JSON the model called the tool with.
            findWriteSubject(writeTool.record, writeTool.action, input as JsonValue),
          ).catch(() => null),
        })
      throw refusal
    }
    const json = toJson(result)
    const output = tool.outputSchema.safeParse(json)
    // The write already committed: refusing now would tell the Owner it was
    // not saved, and a retry would save it twice.
    if (!output.success)
      console.error('tool output does not match its schema', tool.name, output.error)
    const saved = output.success ? output.data : json
    if (write)
      context?.emitCustomEvent(writeEventName, {
        status: 'saved',
        name: tool.name,
        args: input,
        result: saved,
      })
    return saved
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
    bindTool(createAppointmentSeries, run),
    bindTool(findAppointmentSeries, run),
    bindTool(updateAppointmentSeries, run),
    bindTool(softDeleteAppointmentSeries, run),
    bindTool(restoreAppointmentSeries, run),
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
