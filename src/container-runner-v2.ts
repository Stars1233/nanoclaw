/**
 * Container Runner v2
 * Spawns agent containers with session folder + agent group folder mounts.
 * The container runs the v2 agent-runner which polls the session DB.
 */
import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { CONTAINER_IMAGE, DATA_DIR, GROUPS_DIR, IDLE_TIMEOUT, ONECLI_URL, TIMEZONE } from './config.js';
import { CONTAINER_RUNTIME_BIN, hostGatewayArgs, readonlyMountArgs, stopContainer } from './container-runtime.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './mount-security.js';
import {
  markContainerIdle,
  markContainerRunning,
  markContainerStopped,
  sessionDbPath,
  sessionDir,
} from './session-manager.js';
import type { AgentGroup, Session } from './types-v2.js';

const onecli = new OneCLI({ url: ONECLI_URL });

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/** Active containers tracked by session ID. */
const activeContainers = new Map<string, { process: ChildProcess; containerName: string }>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

/**
 * Wake up a container for a session. If already running, no-op.
 * The container runs the v2 agent-runner which polls the session DB.
 */
export async function wakeContainer(session: Session): Promise<void> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return;
  }

  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  const mounts = buildMounts(agentGroup, session);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const agentIdentifier = agentGroup.is_admin ? undefined : agentGroup.folder.toLowerCase().replace(/_/g, '-');
  const args = await buildContainerArgs(mounts, containerName, session, agentGroup, agentIdentifier);

  log.info('Spawning container', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  const container = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  activeContainers.set(session.id, { process: container, containerName });
  markContainerRunning(session.id);

  // Log stderr
  container.stderr?.on('data', (data) => {
    for (const line of data.toString().trim().split('\n')) {
      if (line) log.debug(line, { container: agentGroup.folder });
    }
  });

  // stdout is unused in v2 (all IO is via session DB)
  container.stdout?.on('data', () => {});

  // Idle timeout: kill container after IDLE_TIMEOUT of no activity
  let idleTimer = setTimeout(() => killContainer(session.id, 'idle timeout'), IDLE_TIMEOUT);

  const resetIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => killContainer(session.id, 'idle timeout'), IDLE_TIMEOUT);
  };

  // Reset idle timer when the host detects new messages_out (called by delivery.ts)
  const entry = activeContainers.get(session.id);
  if (entry) {
    (entry as { resetIdle?: () => void }).resetIdle = resetIdle;
  }

  container.on('close', (code) => {
    clearTimeout(idleTimer);
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    log.info('Container exited', { sessionId: session.id, code, containerName });
  });

  container.on('error', (err) => {
    clearTimeout(idleTimer);
    activeContainers.delete(session.id);
    markContainerStopped(session.id);
    log.error('Container spawn error', { sessionId: session.id, err });
  });
}

/** Reset the idle timer for a session's container (called when messages_out are delivered). */
export function resetContainerIdleTimer(sessionId: string): void {
  const entry = activeContainers.get(sessionId) as { resetIdle?: () => void } | undefined;
  entry?.resetIdle?.();
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  try {
    stopContainer(entry.containerName);
  } catch {
    entry.process.kill('SIGKILL');
  }
}

function buildMounts(agentGroup: AgentGroup, session: Session): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);

  // Session folder at /workspace (contains session.db, outbox/, .claude/)
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false });

  // Agent group folder at /workspace/agent
  fs.mkdirSync(groupDir, { recursive: true });
  mounts.push({ hostPath: groupDir, containerPath: '/workspace/agent', readonly: false });

  // Global memory directory
  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    mounts.push({ hostPath: globalDir, containerPath: '/workspace/global', readonly: !agentGroup.is_admin });
  }

  // Claude sessions directory (per agent group, shared across sessions)
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsFile = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(
      settingsFile,
      JSON.stringify(
        {
          env: {
            CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
            CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
            CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
          },
        },
        null,
        2,
      ) + '\n',
    );
  }

  // Sync container skills
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  const skillsDst = path.join(claudeDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (fs.statSync(srcDir).isDirectory()) {
        fs.cpSync(srcDir, path.join(skillsDst, skillDir), { recursive: true });
      }
    }
  }
  mounts.push({ hostPath: claudeDir, containerPath: '/home/node/.claude', readonly: false });

  // Agent-runner source (per agent group, recompiled on container startup)
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  const groupRunnerDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    const srcIndex = path.join(agentRunnerSrc, 'index-v2.ts');
    const cachedIndex = path.join(groupRunnerDir, 'index-v2.ts');
    const needsCopy =
      !fs.existsSync(groupRunnerDir) ||
      !fs.existsSync(cachedIndex) ||
      fs.statSync(srcIndex).mtimeMs > fs.statSync(cachedIndex).mtimeMs;
    if (needsCopy) {
      fs.cpSync(agentRunnerSrc, groupRunnerDir, { recursive: true });
    }
  }
  mounts.push({ hostPath: groupRunnerDir, containerPath: '/app/src', readonly: false });

  // Admin: mount project root read-only
  if (agentGroup.is_admin) {
    mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: true });
    const envFile = path.join(projectRoot, '.env');
    if (fs.existsSync(envFile)) {
      mounts.push({ hostPath: '/dev/null', containerPath: '/workspace/project/.env', readonly: true });
    }
  }

  // Additional mounts from container config
  const containerConfig = agentGroup.container_config ? JSON.parse(agentGroup.container_config) : {};
  if (containerConfig.additionalMounts) {
    const validated = validateAdditionalMounts(
      containerConfig.additionalMounts,
      agentGroup.name,
      !!agentGroup.is_admin,
    );
    mounts.push(...validated);
  }

  return mounts;
}

async function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  session: Session,
  agentGroup: AgentGroup,
  agentIdentifier?: string,
): Promise<string[]> {
  const args: string[] = ['run', '--rm', '--name', containerName];

  // Environment
  args.push('-e', `TZ=${TIMEZONE}`);
  args.push('-e', `AGENT_PROVIDER=${session.agent_provider || agentGroup.agent_provider || 'claude'}`);
  args.push('-e', `SESSION_DB_PATH=/workspace/session.db`);

  // OneCLI gateway
  const onecliApplied = await onecli.applyContainerConfig(args, { addHostMapping: false, agent: agentIdentifier });
  if (onecliApplied) {
    log.debug('OneCLI gateway applied', { containerName });
  }

  // Host gateway
  args.push(...hostGatewayArgs());

  // User mapping
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // Volume mounts
  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  // Override entrypoint: compile agent-runner source, run v2 entry point (no stdin)
  args.push('--entrypoint', 'bash');
  args.push(CONTAINER_IMAGE);
  args.push('-c', 'cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2 && ln -sf /app/node_modules /tmp/dist/node_modules && node /tmp/dist/index-v2.js');

  return args;
}
