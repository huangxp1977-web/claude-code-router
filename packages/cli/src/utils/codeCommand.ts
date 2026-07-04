import { spawn, type StdioOptions } from "child_process";
import {getSettingsPath, readConfigFile} from ".";
import {
  decrementReferenceCount,
  incrementReferenceCount,
  closeService,
} from "./processCheck";
import { quote } from 'shell-quote';
import minimist from "minimist";
import { createEnvVariables } from "./createEnvVariables";
import { select, Separator } from '@inquirer/prompts';
import { readFileSync, existsSync, unlinkSync, rmSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

export interface PresetConfig {
  noServer?: boolean;
  claudeCodeSettings?: {
    env?: Record<string, any>;
    statusLine?: any;
    [key: string]: any;
  };
  provider?: string;
  router?: Record<string, any>;
  StatusLine?: any;  // Preset's StatusLine configuration
  [key: string]: any;
}

interface SessionMetadata {
  sessionId: string;
  project?: string;
  display?: string;
  timestamp?: string | number;
  [key: string]: any;
}

function getProjectDirName(cwd: string): string {
  let posixCwd = cwd.replace(/\\/g, '/');
  if (posixCwd.match(/^[a-zA-Z]:/)) {
    posixCwd = `/mnt/${posixCwd[0].toLowerCase()}${posixCwd.slice(2)}`;
  }
  return posixCwd.replace(/\//g, '-');
}

export async function executeCodeCommand(
  args: string[] = [],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string  // Preset name for statusline command
) {
  // Check for --resume flag and handle it
  if (args.includes('--resume')) {
    await handleResumeCommand(args, presetConfig, envOverrides, presetName);
    return;
  }

  // Set environment variables using shared function
  const config = await readConfigFile();
  const env = await createEnvVariables();

  // Apply environment variable overrides (from preset's provider configuration)
  if (envOverrides) {
    Object.assign(env, envOverrides);
  }

  // Build settingsFlag
  let settingsFlag: ClaudeSettingsFlag = {
    env: env as ClaudeSettingsFlag['env']
  };

  // Add statusLine configuration
  // Priority: preset.StatusLine > global config.StatusLine
  const statusLineConfig = presetConfig?.StatusLine || config?.StatusLine;

  if (statusLineConfig?.enabled) {
    // If using preset, pass preset name to statusline command
    const statuslineCommand = presetName
      ? `ccr statusline ${presetName}`
      : "ccr statusline";

    settingsFlag.statusLine = {
      type: "command",
      command: statuslineCommand,
      padding: 0,
    }
  }

  // Merge claudeCodeSettings from preset into settingsFlag
  if (presetConfig?.claudeCodeSettings) {
    settingsFlag = {
      ...settingsFlag,
      ...presetConfig.claudeCodeSettings,
      // Deep merge env
      env: {
        ...settingsFlag.env,
        ...presetConfig.claudeCodeSettings.env,
      } as ClaudeSettingsFlag['env']
    };
  }

  // Non-interactive mode for automation environments
  if (config.NON_INTERACTIVE_MODE) {
    settingsFlag.env = {
      ...settingsFlag.env,
      CI: "true",
      FORCE_COLOR: "0",
      NODE_NO_READLINE: "1",
      TERM: "dumb"
    }
  }

  const settingsFile = await getSettingsPath(`${JSON.stringify(settingsFlag)}`)

  args.push('--settings', settingsFile);

  // Increment reference count when command starts
  incrementReferenceCount();

  // Execute claude command
  const claudePath = config?.CLAUDE_PATH || process.env.CLAUDE_PATH || "claude";

  const joinedArgs = args.length > 0 ? quote(args) : "";

  const stdioConfig: StdioOptions = config.NON_INTERACTIVE_MODE
    ? ["pipe", "inherit", "inherit"] // Pipe stdin for non-interactive
    : "inherit"; // Default inherited behavior

  const argsObj = minimist(args)
  const argsArr = []
  for (const [argsObjKey, argsObjValue] of Object.entries(argsObj)) {
    if (argsObjKey !== '_' && argsObj[argsObjKey]) {
      const prefix = argsObjKey.length === 1 ? '-' : '--';
      // For boolean flags, don't append the value
      if (argsObjValue === true) {
        argsArr.push(`${prefix}${argsObjKey}`);
      } else {
        argsArr.push(`${prefix}${argsObjKey} ${JSON.stringify(argsObjValue)}`);
      }
    }
  }
  const claudeProcess = spawn(
    claudePath,
    argsArr,
    {
      env: {
        ...process.env,
      },
      stdio: stdioConfig,
      shell: true,
    }
  );

  // Close stdin for non-interactive mode
  if (config.NON_INTERACTIVE_MODE) {
    claudeProcess.stdin?.end();
  }

  claudeProcess.on("error", (error) => {
    console.error("Failed to start claude command:", error.message);
    console.log(
      "Make sure Claude Code is installed: npm install -g @anthropic-ai/claude-code"
    );
    decrementReferenceCount();
    process.exit(1);
  });

  claudeProcess.on("close", (code) => {
    decrementReferenceCount();
    closeService();
    process.exit(code || 0);
  });
}

async function handleResumeCommand(
  args: string[],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
): Promise<void> {
  await showSessionList(args, presetConfig, envOverrides, presetName);
}

async function showSessionList(
  args: string[],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
): Promise<void> {
  const historyPath = join(process.env.HOME || process.env.USERPROFILE || '', '.claude', 'history.jsonl');
  const cwd = process.cwd();
  const projectDir = join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.claude',
    'projects',
    getProjectDirName(cwd)
  );

  const sessions: SessionMetadata[] = [];
  const seenSessionIds = new Set<string>();

  // Read global history.jsonl
  if (existsSync(historyPath)) {
    const historyContent = readFileSync(historyPath, 'utf-8');
    const lines = historyContent.trim().split('\n').filter(line => line.trim());

    for (const line of lines) {
      try {
        const session = JSON.parse(line) as SessionMetadata;
        if (session.sessionId && !seenSessionIds.has(session.sessionId) && session.project === cwd) {
          seenSessionIds.add(session.sessionId);
          sessions.push(session);
        }
      } catch (e) {
        // Skip invalid JSON lines
      }
    }
  }

  // Read project directory .jsonl files for sessions not in history.jsonl
  if (existsSync(projectDir)) {
    const files = readdirSync(projectDir);
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const sessionId = file.replace('.jsonl', '');
      if (seenSessionIds.has(sessionId)) continue;

      const filePath = join(projectDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const firstUserLine = content.split('\n').find(line => {
          try {
            const entry = JSON.parse(line);
            return entry.type === 'user' && entry.message?.content;
          } catch { return false; }
        });
        if (firstUserLine) {
          const entry = JSON.parse(firstUserLine);
          const display = typeof entry.message?.content === 'string'
            ? entry.message.content.substring(0, 40)
            : 'No prompt';
          // Try to get timestamp from first line
          let timestamp = 0;
          const firstLine = content.split('\n')[0];
          try {
            const first = JSON.parse(firstLine);
            timestamp = first.timestamp ? new Date(first.timestamp).getTime() : 0;
          } catch {}
          sessions.push({ sessionId, display, timestamp, project: cwd });
          seenSessionIds.add(sessionId);
        }
      } catch (e) {
        // Skip unreadable files
      }
    }
  }

  // Sort by timestamp descending, take last 20
  const recentSessions = sessions
    .sort((a, b) => {
      let ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
      if (isNaN(ta)) ta = 0;
      let tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
      if (isNaN(tb)) tb = 0;
      return tb - ta;
    })
    .slice(0, 20);

  if (recentSessions.length === 0) {
    console.log('No sessions found in history.');
    process.exit(0);
  }

  const choices: any[] = [];
  for (let i = 0; i < recentSessions.length; i++) {
    const session = recentSessions[i];
    const displayText = session.display
      ? session.display.substring(0, 40) + (session.display.length > 40 ? '...' : '')
      : 'No prompt';
    const date = session.timestamp ? new Date(session.timestamp).toLocaleDateString() : 'Unknown date';
    choices.push({
      name: `  ${displayText} (${date})`,
      value: session.sessionId
    });
    if (i < recentSessions.length - 1) {
      choices.push(new Separator('─'.repeat(60)));
    }
  }

  choices.push(new Separator('─'.repeat(60)));
  choices.push({ name: '✕ Cancel', value: '__cancel__' });

  const selectedSessionId = await select({
    message: 'Select session to resume:',
    choices: choices,
    loop: false
  });

  if (selectedSessionId === '__cancel__') {
    process.exit(0);
  }

  // Clear screen before next prompt to avoid leftover text
  process.stdout.write('\x1b[2J\x1b[H');
  await showSessionActions(selectedSessionId, args, presetConfig, envOverrides, presetName);
}

async function showSessionActions(
  sessionId: string,
  args: string[],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
): Promise<void> {
  const action = await select({
    message: 'Select action:',
    choices: [
          { name: 'Resume session', value: 'resume' },
          { name: 'Delete session', value: 'delete' },
          { name: '← Back', value: '__back__' }
        ],
    loop: false
  });

  if (action === 'resume') {
      await resumeSession(sessionId, args, presetConfig, envOverrides, presetName);
    } else if (action === 'delete') {
      await deleteSession(sessionId, args, presetConfig, envOverrides, presetName);
    } else if (action === '__back__') {
      await showSessionList(args, presetConfig, envOverrides, presetName);
    }
}

async function resumeSession(
  sessionId: string,
  args: string[],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
): Promise<void> {
  // Filter out --resume from args and add -r <sessionId>
  const filteredArgs = args.filter(arg => arg !== '--resume');
  const resumeArgs = ['-r', sessionId, ...filteredArgs];

  // Clear screen completely before launching Claude Code
  process.stdout.write('\x1b[2J\x1b[H');

  // Execute the command with the resume flag
  await executeCodeCommand(resumeArgs, presetConfig, envOverrides, presetName);
}

async function deleteSession(
  sessionId: string,
  args: string[],
  presetConfig?: PresetConfig | null,
  envOverrides?: Record<string, string>,
  presetName?: string
): Promise<void> {
  const claudeDir = join(process.env.HOME || process.env.USERPROFILE || '', '.claude');
  const projectsDir = join(claudeDir, 'projects');
  const tasksDir = join(claudeDir, 'tasks');
  const historyPath = join(claudeDir, 'history.jsonl');

  // Delete matching .jsonl files and folders in projects directory
  if (existsSync(projectsDir)) {
    const projectDirs = readdirSync(projectsDir);
    for (const projectDir of projectDirs) {
      const projectPath = join(projectsDir, projectDir);
      const stat = statSync(projectPath);

      if (stat.isDirectory()) {
        // Check for <sessionId>.jsonl file
        const jsonlPath = join(projectPath, `${sessionId}.jsonl`);
        if (existsSync(jsonlPath)) {
          unlinkSync(jsonlPath);
        }

        // Check for <sessionId> folder
        const sessionFolderPath = join(projectPath, sessionId);
        if (existsSync(sessionFolderPath)) {
          rmSync(sessionFolderPath, { recursive: true, force: true });
        }
      }
    }
  }

  // Delete task folder if exists
  const taskFolderPath = join(tasksDir, sessionId);
  if (existsSync(taskFolderPath)) {
    rmSync(taskFolderPath, { recursive: true, force: true });
  }

  // Remove session from history.jsonl
  if (existsSync(historyPath)) {
    const historyContent = readFileSync(historyPath, 'utf-8');
    const lines = historyContent.split('\n');
    const filteredLines = lines.filter(line => {
      if (!line.trim()) return false;
      try {
        const session = JSON.parse(line) as SessionMetadata;
        return session.sessionId !== sessionId;
      } catch {
        return true; // Keep non-JSON lines
      }
    });
    writeFileSync(historyPath, filteredLines.join('\n'), 'utf-8');
  }

  console.log('会话已删除');

  // Show session list again
  await showSessionList(args, presetConfig, envOverrides, presetName);
}
