import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrimerTool, pickPermission } from '../src/agent/acp.ts';

/**
 * The ACP transport auto-approves tool calls during an unattended run, with no
 * adult watching. The whole safety property of the unattended tutor — "no Bash,
 * no Read, no Write, no WebFetch, ever" — collapses to whatever this one check
 * decides. It must be checking something the model cannot phrase however it
 * likes: the earlier version matched substrings against `title` and `rawInput`,
 * which are exactly that, and a Bash call titled to mention a primer tool name
 * would have sailed through as "looks like a primer tool".
 */

test('a real primer tool is allowed', () => {
  assert.equal(isPrimerTool('mcp__primer__next_targets'), true);
  assert.equal(isPrimerTool('mcp__primer__save_interface'), true);
});

test('a tool call with no programmatic name is denied, not guessed at', () => {
  // Undefined/null `name` means there is no trustworthy identity signal at all.
  // Falling back to title or arguments is how the substring bug got in.
  assert.equal(isPrimerTool(undefined), false);
  assert.equal(isPrimerTool(null), false);
  assert.equal(isPrimerTool(''), false);
});

test('a disallowed tool whose title or arguments merely mention a primer tool is refused', () => {
  // This is the exact shape of the bypass the old check had: a Bash tool call can
  // be given any title and any argument string the model likes.
  assert.equal(isPrimerTool('Bash'), false);
  assert.equal(isPrimerTool('bash'), false);
  assert.equal(isPrimerTool('Read'), false);
  assert.equal(isPrimerTool('WebFetch'), false);
});

test('a tool from a different MCP server is refused even with a similar name', () => {
  // Exact match only — a same-named tool on an unrelated server, or a near-miss
  // typo/prefix, must not slide through.
  assert.equal(isPrimerTool('mcp__other__next_targets'), false);
  assert.equal(isPrimerTool('mcp__primer__next_targetsX'), false);
  assert.equal(isPrimerTool('next_targets'), false);
});

test('every allowed name is one of the tools the CLI transport allows', () => {
  // The two transports must agree on the boundary — approving over ACP something
  // the CLI path denies would make the transport choice into a privilege escalation.
  const names = [
    'mcp__primer__learner_context',
    'mcp__primer__save_interface',
    'mcp__primer__record_observations',
  ];
  for (const n of names) assert.equal(isPrimerTool(n), true, `${n} should be allowed`);

  const notAutonomous = ['mcp__primer__create_learner', 'mcp__primer__add_accommodation'];
  for (const n of notAutonomous) {
    assert.equal(isPrimerTool(n), false, `${n} is not in AUTONOMOUS_TOOLS and must stay denied`);
  }
});

test('pickPermission selects an allow option only for a real primer tool', () => {
  const options = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'r1', name: 'Reject once', kind: 'reject_once' as const },
  ];

  const allowed = pickPermission({
    sessionId: 's1',
    toolCall: { toolCallId: 't1', name: 'mcp__primer__next_targets' },
    options,
  } as any);
  assert.deepEqual(allowed, { outcome: { outcome: 'selected', optionId: 'a1' } });

  const denied = pickPermission({
    sessionId: 's1',
    toolCall: { toolCallId: 't2', name: null, title: 'mcp__primer__next_targets (definitely)' },
    options,
  } as any);
  assert.deepEqual(denied, { outcome: { outcome: 'selected', optionId: 'r1' } });
});

test('pickPermission cancels rather than guesses when there is no matching option', () => {
  const result = pickPermission({
    sessionId: 's1',
    toolCall: { toolCallId: 't1', name: 'Bash' },
    options: [{ optionId: 'x', name: 'Something else', kind: 'allow_once' as const }],
  } as any);
  assert.deepEqual(result, { outcome: { outcome: 'cancelled' } });
});
