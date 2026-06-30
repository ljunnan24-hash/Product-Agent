import type { AgentRuntimeToolId } from "./types";

export type WorkerDaemonSupportedTool = {
  toolId: Extract<
    AgentRuntimeToolId,
    "web_search" | "web_fetch" | "evidence_extract" | "judge" | "model_report" | "code_execute"
  >;
  label: string;
  replayScope: "durable_worker";
  status: "supported";
};

export const workerDaemonSupportedTools: WorkerDaemonSupportedTool[] = [
  {
    toolId: "web_search",
    label: "Web Search",
    replayScope: "durable_worker",
    status: "supported"
  },
  {
    toolId: "web_fetch",
    label: "Web Fetch",
    replayScope: "durable_worker",
    status: "supported"
  },
  {
    toolId: "code_execute",
    label: "Code Execute",
    replayScope: "durable_worker",
    status: "supported"
  },
  {
    toolId: "evidence_extract",
    label: "Evidence Extract",
    replayScope: "durable_worker",
    status: "supported"
  },
  {
    toolId: "judge",
    label: "Judge Agent",
    replayScope: "durable_worker",
    status: "supported"
  },
  {
    toolId: "model_report",
    label: "Report Composer",
    replayScope: "durable_worker",
    status: "supported"
  }
];

export function supportedWorkerDaemonToolLabels() {
  return workerDaemonSupportedTools.map((tool) => tool.label);
}

export function isWorkerDaemonSupportedTool(toolId: string) {
  return workerDaemonSupportedTools.some((tool) => tool.toolId === toolId);
}
