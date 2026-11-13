import type { ToolDefinition } from "./common.js";
import { navigateTool, statusTool, testConnectionTool } from "./account.js";
import { teamsFindTool, teamsGetTool, teamsListTool } from "./teams.js";
import { usageGetTool, usageHistoryTool } from "./usage.js";
import { messagesSearchTool } from "./messages.js";
import { statisticsTool, threatSummaryTool } from "./statistics.js";
import { reportedMailGetTool, reportedMailItemActionsTool, reportedMailListTool } from "./reported-mail.js";
import {
  adminsGetTool,
  adminsListTool,
  allowListGetTool,
  allowListListTool,
  blockListGetTool,
  blockListListTool,
  resultTypesTool,
  vipsGetTool,
  vipsListTool,
} from "./lists.js";
import { rawRequestTool } from "./raw.js";

/** Every INKY API tool except inky_navigate (which lists these). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous schemas in one registry
const API_TOOLS: ToolDefinition<any>[] = [
  statusTool,
  testConnectionTool,
  teamsListTool,
  teamsFindTool,
  teamsGetTool,
  usageGetTool,
  usageHistoryTool,
  messagesSearchTool,
  statisticsTool,
  threatSummaryTool,
  reportedMailListTool,
  reportedMailGetTool,
  reportedMailItemActionsTool,
  allowListListTool,
  allowListGetTool,
  blockListListTool,
  blockListGetTool,
  vipsListTool,
  vipsGetTool,
  adminsListTool,
  adminsGetTool,
  resultTypesTool,
  rawRequestTool,
];

function listing(tools: ToolDefinition[]): Record<string, Array<{ name: string; title: string }>> {
  const out: Record<string, Array<{ name: string; title: string }>> = {};
  for (const tool of tools) (out[tool.domain] ??= []).push({ name: tool.name, title: tool.title });
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- heterogeneous schemas in one registry
export function getTools(options: { rawRequestEnabled: boolean }): ToolDefinition<any>[] {
  const tools = options.rawRequestEnabled ? API_TOOLS : API_TOOLS.filter((t) => t !== rawRequestTool);
  return [navigateTool(() => listing(tools)), ...tools];
}
