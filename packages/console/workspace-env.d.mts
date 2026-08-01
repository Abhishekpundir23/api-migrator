export interface WorkspaceEnvResult {
  combinedEnv: NodeJS.ProcessEnv;
  parsedEnv?: Record<string, string>;
  loadedEnvFiles: Array<{ path: string; contents: string; env: Record<string, string> }>;
}

export function loadWorkspaceEnv(workspaceRoot: string): WorkspaceEnvResult;
