import { toolDefinition } from '@tanstack/ai'

import {
  createClient,
  createService,
  findClients,
  findServices,
  softDeleteClient,
  softDeleteService,
  updateClient,
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

export const chatTools = [
  createClientTool,
  findClientsTool,
  updateClientTool,
  softDeleteClientTool,
  createServiceTool,
  findServicesTool,
  updateServiceTool,
  softDeleteServiceTool,
]
