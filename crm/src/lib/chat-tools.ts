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

export const createClientTool = toolDefinition({
  name: createClient.name,
  description: createClient.description,
  inputSchema: createClient.inputSchema,
}).server((input) => createClient.execute(input))

export const findClientsTool = toolDefinition({
  name: findClients.name,
  description: findClients.description,
  inputSchema: findClients.inputSchema,
}).server((input) => findClients.execute(input))

export const updateClientTool = toolDefinition({
  name: updateClient.name,
  description: updateClient.description,
  inputSchema: updateClient.inputSchema,
}).server((input) => updateClient.execute(input))

export const softDeleteClientTool = toolDefinition({
  name: softDeleteClient.name,
  description: softDeleteClient.description,
  inputSchema: softDeleteClient.inputSchema,
}).server((input) => softDeleteClient.execute(input))

export const restoreClientTool = toolDefinition({
  name: restoreClient.name,
  description: restoreClient.description,
  inputSchema: restoreClient.inputSchema,
}).server((input) => restoreClient.execute(input))

export const createServiceTool = toolDefinition({
  name: createService.name,
  description: createService.description,
  inputSchema: createService.inputSchema,
}).server((input) => createService.execute(input))

export const findServicesTool = toolDefinition({
  name: findServices.name,
  description: findServices.description,
  inputSchema: findServices.inputSchema,
}).server((input) => findServices.execute(input))

export const updateServiceTool = toolDefinition({
  name: updateService.name,
  description: updateService.description,
  inputSchema: updateService.inputSchema,
}).server((input) => updateService.execute(input))

export const softDeleteServiceTool = toolDefinition({
  name: softDeleteService.name,
  description: softDeleteService.description,
  inputSchema: softDeleteService.inputSchema,
}).server((input) => softDeleteService.execute(input))

export const restoreServiceTool = toolDefinition({
  name: restoreService.name,
  description: restoreService.description,
  inputSchema: restoreService.inputSchema,
}).server((input) => restoreService.execute(input))

export const createAppointmentTool = toolDefinition({
  name: createAppointment.name,
  description: createAppointment.description,
  inputSchema: createAppointment.inputSchema,
}).server((input) => createAppointment.execute(input))

export const findAppointmentsTool = toolDefinition({
  name: findAppointments.name,
  description: findAppointments.description,
  inputSchema: findAppointments.inputSchema,
}).server((input) => findAppointments.execute(input))

export const updateAppointmentTool = toolDefinition({
  name: updateAppointment.name,
  description: updateAppointment.description,
  inputSchema: updateAppointment.inputSchema,
}).server((input) => updateAppointment.execute(input))

export const softDeleteAppointmentTool = toolDefinition({
  name: softDeleteAppointment.name,
  description: softDeleteAppointment.description,
  inputSchema: softDeleteAppointment.inputSchema,
}).server((input) => softDeleteAppointment.execute(input))

export const restoreAppointmentTool = toolDefinition({
  name: restoreAppointment.name,
  description: restoreAppointment.description,
  inputSchema: restoreAppointment.inputSchema,
}).server((input) => restoreAppointment.execute(input))

export const createPaymentTool = toolDefinition({
  name: createPayment.name,
  description: createPayment.description,
  inputSchema: createPayment.inputSchema,
}).server((input) => createPayment.execute(input))

export const findPaymentsTool = toolDefinition({
  name: findPayments.name,
  description: findPayments.description,
  inputSchema: findPayments.inputSchema,
}).server((input) => findPayments.execute(input))

export const updatePaymentTool = toolDefinition({
  name: updatePayment.name,
  description: updatePayment.description,
  inputSchema: updatePayment.inputSchema,
}).server((input) => updatePayment.execute(input))

export const softDeletePaymentTool = toolDefinition({
  name: softDeletePayment.name,
  description: softDeletePayment.description,
  inputSchema: softDeletePayment.inputSchema,
}).server((input) => softDeletePayment.execute(input))

export const restorePaymentTool = toolDefinition({
  name: restorePayment.name,
  description: restorePayment.description,
  inputSchema: restorePayment.inputSchema,
}).server((input) => restorePayment.execute(input))

export const listAuditLogTool = toolDefinition({
  name: listAuditLog.name,
  description: listAuditLog.description,
  inputSchema: listAuditLog.inputSchema,
}).server((input) => listAuditLog.execute(input))

export const chatTools = [
  createClientTool,
  findClientsTool,
  updateClientTool,
  softDeleteClientTool,
  restoreClientTool,
  createServiceTool,
  findServicesTool,
  updateServiceTool,
  softDeleteServiceTool,
  restoreServiceTool,
  createAppointmentTool,
  findAppointmentsTool,
  updateAppointmentTool,
  softDeleteAppointmentTool,
  restoreAppointmentTool,
  createPaymentTool,
  findPaymentsTool,
  updatePaymentTool,
  softDeletePaymentTool,
  restorePaymentTool,
  listAuditLogTool,
]
