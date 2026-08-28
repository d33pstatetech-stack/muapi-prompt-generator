#!/usr/bin/env node
/**
 * Venice API smoke test — verifies VENICE_API_KEY + baseURL work.
 * Reads VENICE_API_KEY from env (.env / .dev.vars / process.env).
 * Uses Venice's OpenAI-compatible /chat/completions endpoint.
 * Docs: https://docs.venice.ai
 */
const fs = require('fs');
const path = require('path');

// Tiny .env loader (no dotenv dep) — checks .env then .dev.vars
(function loadEnv() {
  for (const fname of ['.env', '.dev.vars']) {
    const p = path.join(__dirname, '..', fname);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf-8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
})();

const VENICE_API_KEY = process.env.VENICE_API_KEY || '';
const VENICE_BASE_URL = process.env.VENICE_BASE_URL || 'https://api.venice.ai/api/v1';
const MODEL = process.env.VENICE_MODEL || 'dolphin-mixtral';

if (!VENICE_API_KEY) {
  console.error('Missing VENICE_API_KEY — set it in .env as VENICE_API_KEY=...');
  process.exit(1);
}

async function main() {
  console.log(`Testing Venice API — baseURL=${VENICE_BASE_URL} model=${MODEL}`);
  const url = `${VENICE_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${VENICE_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'Hello! Are you dolphin-mixtral? Answer in one short sentence.' }],
      max_tokens: 80,
      temperature: 0.7,
    }),
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok) {
    console.error(`Venice API error ${res.status}:`, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const content = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || JSON.stringify(data).slice(0, 500);
  console.log('✓ Venice OK — response:');
  console.log(content.trim());
  if (data.usage) console.log('usage:', data.usage);
}

main().catch((e) => {
  console.error('Venice test failed:', e.message);
  process.exit(1);
});
