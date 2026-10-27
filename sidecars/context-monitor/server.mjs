import { SidecarApp } from 'sidecar_sdk';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = new SidecarApp();

app.page('/', () => {
  return readFileSync(join(__dirname, 'index.html'), 'utf-8');
});

function isValidConversationId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
}

function resolveSessionId(explicitInput) {
  if (explicitInput === undefined || explicitInput === null || explicitInput === '')
    return { status: 'unbound', id: null };
  return isValidConversationId(explicitInput)
    ? { status: 'valid', id: explicitInput }
    : { status: 'invalid_id', id: null };
}

function getTranscriptPath(validId) {
  if (!validId || !isValidConversationId(validId)) return null;

  const brainDir = resolve(homedir(), '.gemini', 'antigravity', 'brain');
  const targetPath = resolve(brainDir, validId, '.system_generated', 'logs', 'transcript.jsonl');

  if (!targetPath.startsWith(brainDir + sep)) {
    return null;
  }

  if (!existsSync(targetPath)) {
    return null;
  }

  try {
    const realBrainDir = realpathSync(brainDir);
    const realTargetPath = realpathSync(targetPath);
    if (!realTargetPath.startsWith(realBrainDir + sep)) {
      return null;
    }
    return realTargetPath;
  } catch {
    return null;
  }
}

function parseBucket(b) {
  if (!b) return null;
  const frac = b.remainingFraction;
  const isValid = typeof frac === 'number' && Number.isFinite(frac) && frac >= 0 && frac <= 1;
  const pct = isValid ? Math.floor(Number((frac * 100).toFixed(6))) : null;
  const match = typeof b.description === 'string' ? b.description.match(/in ([^.]+)/) : null;
  const refreshText = match ? `Refreshes in ${match[1].trim()}` : (b.resetTime ? 'Reset scheduled' : '');
  return {
    pct,
    name: b.displayName || 'Limit Remaining',
    refresh: refreshText
  };
}

function parseLoopbackAddress(raw) {
  if (typeof raw !== 'string') return null;
  const match = raw.trim().match(/^(127\.0\.0\.1|localhost|\[::1\]):([1-9][0-9]{0,4})$/i);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const hostInput = match[1].toLowerCase();
  return {
    hostname: hostInput === '[::1]' ? '::1' : '127.0.0.1',
    port
  };
}

function fetchAllQuotas() {
  const ls = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!ls || !csrf) return Promise.resolve(null);
  const target = parseLoopbackAddress(ls);
  if (!target) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    let deadline = null;
    const finish = value => { if (!settled) { settled = true; if (deadline !== null) clearTimeout(deadline); resolve(value); } };
    const abort = () => { try { req?.destroy(); } catch {} finish(null); };
    const payload = JSON.stringify({});
    try {
    req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': csrf,
        'Content-Length': Buffer.byteLength(payload)
      },
      timeout: 2500
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return finish(null);
      }
      let data = '';
      res.on('error', () => finish(null));
      res.on('aborted', () => finish(null));
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 1024 * 1024) abort();
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const groups = parsed?.response?.groups;
          if (!Array.isArray(groups)) {
            return finish(null);
          }
          
          const result = {};

          // 1. Gemini Models - Strictly match name, NO groups[0] fallback!
          const geminiGroup = groups.find(g => /Gemini Models/i.test(g.displayName));
          if (geminiGroup) {
            result.gemini = {
              title: 'Gemini Models',
              weekly: parseBucket(geminiGroup.buckets?.find(b => /weekly/i.test(b.bucketId || b.displayName))),
              fiveHour: parseBucket(geminiGroup.buckets?.find(b => /5h|five/i.test(b.bucketId || b.displayName)))
            };
          }

          // 2. Gemini 4 Argon
          const argonGroup = groups.find(g => /Argon/i.test(g.displayName));
          if (argonGroup) {
            result.argon = {
              title: argonGroup.displayName || 'Gemini 4 Argon',
              weekly: parseBucket(argonGroup.buckets?.find(b => /weekly/i.test(b.bucketId || b.displayName))),
              fiveHour: null
            };
          }

          // 3. Claude and GPT models
          const claudeGroup = groups.find(g => /Claude|GPT/i.test(g.displayName));
          if (claudeGroup) {
            const cWeekly = parseBucket(claudeGroup.buckets?.find(b => /weekly/i.test(b.bucketId || b.displayName)));
            const c5h = parseBucket(claudeGroup.buckets?.find(b => /5h|five/i.test(b.bucketId || b.displayName)));
            result.claude = {
              title: claudeGroup.displayName || 'Claude and GPT models',
              weekly: cWeekly,
              fiveHour: c5h
            };
          }

          finish(result);
        } catch (e) {
          finish(null);
        }
      });
    });

    req.on('error', () => finish(null));
    req.on('timeout', abort);
    deadline = setTimeout(abort, 3000);
    req.write(payload);
    req.end();
    } catch {
      abort();
    }
  });
}

async function getQuotaSummary() {
  const freshQuotas = await fetchAllQuotas();
  return freshQuotas ? { ...freshQuotas, lastFetchSuccess: true } : { lastFetchSuccess: false };
}

function modelFromSettings(content) {
  const block = content.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/);
  if (!block) return null;
  // Host format: "The user changed setting `Model Selection` from X to Y. No need to ..."
  const sentence = block[1].match(/changed setting\s+`?Model Selection`?\s+from\s+[\s\S]+?\s+to\s+([\s\S]+?)\.(?:\s|$)/i);
  const fromSentence = sentence?.[1]?.trim();
  if (fromSentence && !/^none$/i.test(fromSentence)) return fromSentence;
  const field = block[1].match(/(?:^|[\n,;])\s*model\s*:\s*([^\n,;<]+)/i);
  return field?.[1]?.trim() || null;
}

function validCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseUsage(content) {
  let modelName = null;
  let usage = null;
  let awaiting = false;
  for (const line of content.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === 'USER_INPUT' && typeof event.content === 'string') {
      const setting = modelFromSettings(event.content);
      if (setting) { modelName = setting; usage = null; awaiting = true; }
    } else if (event?.type === 'PLANNER_RESPONSE') {
      const fields = [event.input_tokens, event.cache_read_tokens, event.output_tokens];
      // All three fields are required; malformed or absent counts are unknown, never zero.
      if (fields.every(validCount)) {
        usage = { inputTokens: fields[0], cachedTokens: fields[1], outputTokens: fields[2] };
        awaiting = false;
      } else {
        usage = null;
        awaiting = true;
      }
    }
  }
  return { modelName, usage, awaiting };
}

function handleStatus(params) {
  const validContainer = params === undefined || (params !== null && typeof params === 'object' && !Array.isArray(params));
  const session = validContainer ? resolveSessionId(params?.conversationId) : { status: 'invalid_id', id: null };
  let contextStatus = session.status;
  let modelName = null;
  let usage = null;
  if (session.status === 'valid') {
    const path = getTranscriptPath(session.id);
    if (path) {
      try {
        const parsed = parseUsage(readFileSync(path, 'utf-8'));
        modelName = parsed.modelName;
        usage = parsed.usage;
        contextStatus = usage ? 'ready' : parsed.awaiting ? 'awaiting_usage' : 'unavailable';
      } catch { contextStatus = 'unavailable'; }
    } else contextStatus = 'unavailable';
  }
  const totalUsed = usage ? usage.inputTokens + usage.cachedTokens + usage.outputTokens : null;
  return {
    contextStatus, conversationId: session.id, modelName, totalUsed,
    breakdown: usage || { inputTokens: null, cachedTokens: null, outputTokens: null }
  };
}

app.api('/api/status', handleStatus, 'POST');
app.api('/api/status', handleStatus, 'GET');
app.api('/api/quotas', getQuotaSummary, 'POST');

await app.run();
