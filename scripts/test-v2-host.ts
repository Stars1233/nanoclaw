/**
 * Real end-to-end test of v2: host router → Docker container → agent-runner → delivery.
 *
 * 1. Init central DB with agent group + messaging group + wiring
 * 2. Route an inbound message (creates session, writes messages_in, spawns container)
 * 3. Container runs v2 agent-runner, polls session DB, queries Claude
 * 4. Poll session DB for messages_out response
 *
 * Usage: npx tsx scripts/test-v2-host.ts
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const TEST_DIR = '/tmp/nanoclaw-v2-e2e';
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
fs.mkdirSync(TEST_DIR, { recursive: true });

// --- Step 1: Init central DB ---
console.log('\n=== Step 1: Init central DB ===');

import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createAgentGroup } from '../src/db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../src/db/messaging-groups.js';

const centralDb = initDb(path.join(TEST_DIR, 'v2.db'));
runMigrations(centralDb);

// Create groups dir for agent folder mount
const groupsDir = path.resolve(process.cwd(), 'groups');
const testGroupDir = path.join(groupsDir, 'test-agent-e2e');
fs.mkdirSync(testGroupDir, { recursive: true });
fs.writeFileSync(path.join(testGroupDir, 'CLAUDE.md'), '# Test Agent\nYou are a test agent. Be brief.\n');

createAgentGroup({
  id: 'ag-e2e',
  name: 'E2E Test Agent',
  folder: 'test-agent-e2e',
  is_admin: 0,
  agent_provider: 'claude',
  container_config: null,
  created_at: new Date().toISOString(),
});

createMessagingGroup({
  id: 'mg-e2e',
  channel_type: 'test',
  platform_id: 'e2e-channel',
  name: 'E2E Test Channel',
  is_group: 0,
  admin_user_id: null,
  created_at: new Date().toISOString(),
});

createMessagingGroupAgent({
  id: 'mga-e2e',
  messaging_group_id: 'mg-e2e',
  agent_group_id: 'ag-e2e',
  trigger_rules: null,
  response_scope: 'all',
  session_mode: 'shared',
  priority: 0,
  created_at: new Date().toISOString(),
});

console.log('✓ Central DB initialized');

// --- Step 2: Route inbound message (spawns container) ---
console.log('\n=== Step 2: Route inbound message ===');

import { routeInbound } from '../src/router-v2.js';
import { findSession } from '../src/db/sessions.js';
import { sessionDbPath } from '../src/session-manager.js';

await routeInbound({
  channelType: 'test',
  platformId: 'e2e-channel',
  threadId: null,
  message: {
    id: 'msg-e2e-1',
    kind: 'chat',
    content: JSON.stringify({
      sender: 'Gavriel',
      text: 'Say "E2E works!" and nothing else. Do not use any tools.',
    }),
    timestamp: new Date().toISOString(),
  },
});

const session = findSession('mg-e2e', null);
if (!session) {
  console.log('✗ No session created!');
  process.exit(1);
}
console.log(`✓ Session: ${session.id}`);
console.log(`✓ Container status: ${session.container_status}`);

const sessDbPath = sessionDbPath('ag-e2e', session.id);
console.log(`✓ Session DB: ${sessDbPath}`);

// --- Step 3: Wait for response ---
console.log('\n=== Step 3: Waiting for Claude response... ===');

const startTime = Date.now();
const TIMEOUT_MS = 120_000;

const checkForResponse = (): boolean => {
  try {
    const db = new Database(sessDbPath, { readonly: true });
    const out = db.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
    db.close();
    return out.length > 0;
  } catch {
    return false;
  }
};

await new Promise<void>((resolve) => {
  const poll = () => {
    if (checkForResponse()) {
      resolve();
      return;
    }
    if (Date.now() - startTime > TIMEOUT_MS) {
      console.log(`\n✗ Timed out after ${TIMEOUT_MS / 1000}s`);
      printState();
      process.exit(1);
    }
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    if (elapsed > 0 && elapsed % 10 === 0) {
      process.stdout.write(`  ${elapsed}s...`);
    }
    setTimeout(poll, 1000);
  };
  poll();
});

// --- Step 4: Print results ---
console.log('\n\n=== Results ===');
printState();

// Clean up test group dir
fs.rmSync(testGroupDir, { recursive: true, force: true });

process.exit(0);

function printState() {
  try {
    const db = new Database(sessDbPath, { readonly: true });
    const inRows = db.prepare('SELECT * FROM messages_in').all() as Array<Record<string, unknown>>;
    const outRows = db.prepare('SELECT * FROM messages_out').all() as Array<Record<string, unknown>>;
    db.close();

    console.log('\nmessages_in:');
    for (const r of inRows) {
      console.log(`  [${r.id}] status=${r.status} kind=${r.kind}`);
    }
    console.log('\nmessages_out:');
    for (const r of outRows) {
      const content = JSON.parse(r.content as string);
      console.log(`  [${r.id}] kind=${r.kind}`);
      console.log(`  → ${content.text}`);
    }
  } catch (err) {
    console.log(`  (could not read session DB: ${err})`);
  }
}
