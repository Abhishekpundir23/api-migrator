export interface WorkspaceEnvResult {
  combinedEnv: NodeJS.ProcessEnv;
  parsedEnv?: Record<string, string>;
  loadedEnvFiles: Array<{ path: string; contents: string; env: Record<string, string> }>;
}

export function assertWorkspaceEnvFilesSecure(
  workspaceRoot: string,
  development: boolean
): void;

export function loadWorkspaceEnv(workspaceRoot: string): WorkspaceEnvResult;
