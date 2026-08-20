#!/usr/bin/env node
/**
 * parse-openapi-seed.js
 *
 * Uses the LIVE CATALOG as the primary source of truth for model IDs and endpoints.
 * Matches each catalog model to an OpenAPI schema by stripping common suffixes.
 * Generates a complete seed.sql for D1.
 *
 * Usage: node scripts/parse-openapi-seed.js
 * Output: migrations/0002_seed.sql
 */

const fs = require('fs');
const path = require('path');

const OPENAPI_URL = 'https://api.muapi.ai/openapi.json';
// Optional local markdown for category metadata — set via env or place file at this path
const LLMSTXT_PATH = process.env.MUAPI_LLMSTXT_PATH || path.join(__dirname, '..', 'MuAPI_llms.md');
const OUTPUT_SQL = path.join(__dirname, '..', 'migrations', '0002_seed.sql');
const CACHED_SPEC = path.join(__dirname, '..', '.cache', 'openapi.json');

const CATEGORY_MAP = {
  'Text-to-Image Models': 'Text to Image',
  'Image Editing & Enhancement Models': 'Image to Image',
  'Text-to-Video Models': 'Text to Video',
  'Image-to-Video Models': 'Image to Video',
  'Video Editing & Effect Models': 'Video to Video',
  'Audio Models': 'Text to Audio',
  'Lipsync / Audio-to-Video Models': 'Audio to Video',
  '3D Models': 'Text to 3D',
  'Training Models': 'Training',
  'Text Models': 'Text to Text',
  'Other Models': 'Other',
};

const TAG_TO_CATEGORY = {
  'Image: Text-to-Image': 'Text to Image',
  'Image: Edit & Reference': 'Image to Image',
  'Image: Enhance': 'Image to Image',
  'Video: Text-to-Video': 'Text to Video',
  'Video: Image-to-Video': 'Image to Video',
  'Video: Edit & Effects': 'Video to Video',
  'Video: Lipsync': 'Audio to Video',
  'Video: Avatars': 'Audio to Video',
  'Video: Storyboard': 'Text to Video',
  'Audio': 'Text to Audio',
  '3D Generation': 'Text to 3D',
  'LLM / Multimodal': 'Text to Text',
  'API': 'Other',
  'Utilities': 'Other',
  'Creative Agent': 'Other',
  'Account': 'Other',
  'Other': 'Other',
};

// Suffixes to strip when matching catalog names to OpenAPI paths
const STRIP_SUFFIXES = [
  '-text-to-image', '-text-to-video', '-image-to-video', '-image-to-image',
  '-text-to-3d', '-text-to-audio',
  '-t2i', '-t2v', '-i2v', '-i2i', '-t2a',
  '-image', '-video', '-audio',
];

async function getOpenAPISpec() {
  if (fs.existsSync(CACHED_SPEC)) {
    console.log('   Reading cached spec...');
    return JSON.parse(fs.readFileSync(CACHED_SPEC, 'utf-8'));
  }
  console.log('   Fetching OpenAPI spec...');
  const res = await fetch(OPENAPI_URL);
  if (!res.ok) throw new Error(`Failed to fetch: ${res.status}`);
  const spec = await res.json();
  fs.mkdirSync(path.dirname(CACHED_SPEC), { recursive: true });
  fs.writeFileSync(CACHED_SPEC, JSON.stringify(spec), 'utf-8');
  return spec;
}

function parseMarkdownCategories(content) {
  const models = {};
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let currentCategory = 'Other';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('## ')) {
      const header = trimmed.slice(3).trim();
      if (CATEGORY_MAP[header]) currentCategory = CATEGORY_MAP[header];
    }
    const m = trimmed.match(/^- \*\*(.+?)\*\*\s*\u2014\s*`POST https:\/\/api\.muapi\.ai\/api\/v1\/(.+?)`\s*\u2014\s*(.+)$/);
    if (m) {
      models[m[1]] = { id: m[1], endpoint: '/api/v1/' + m[2], description: m[3].trim(), category: currentCategory };
    }
  }
  return models;
}

function resolveRef(ref, schemas) {
  if (!ref || !ref.startsWith('#/components/schemas/')) return null;
  return schemas[ref.replace('#/components/schemas/', '')] || null;
}

function extractProperty(name, prop, schemas, requiredFields) {
  const result = { type: 'string' };
  const isRequired = requiredFields.includes(name);

  if (prop.$ref) {
    const resolved = resolveRef(prop.$ref, schemas);
    result.type = 'object';
    result.$ref = prop.$ref.replace('#/components/schemas/', '');
    if (resolved?.title) result.title = resolved.title;
  } else if (prop.anyOf) {
    const nonNull = prop.anyOf.find(p => p.type !== 'null');
    if (nonNull) {
      if (nonNull.$ref) {
        result.type = 'object';
        result.$ref = nonNull.$ref.replace('#/components/schemas/', '');
      } else {
        result.type = mapType(nonNull.type);
        if (nonNull.format) result.format = nonNull.format;
        if (nonNull.enum) result.options = nonNull.enum;
        if (nonNull.minimum !== undefined) result.min = nonNull.minimum;
        if (nonNull.maximum !== undefined) result.max = nonNull.maximum;
        if (nonNull.minLength !== undefined) result.minLength = nonNull.minLength;
        if (nonNull.maxLength !== undefined) result.maxLength = nonNull.maxLength;
      }
    }
    result.nullable = true;
  } else if (prop.allOf) {
    const merged = prop.allOf.find(p => p.$ref || p.type);
    if (merged) return extractProperty(name, merged, schemas, requiredFields);
  } else {
    result.type = mapType(prop.type);
    if (prop.format) result.format = prop.format;
    if (prop.enum) result.options = prop.enum;
    if (prop.minimum !== undefined) result.min = prop.minimum;
    if (prop.maximum !== undefined) result.max = prop.maximum;
    if (prop.minLength !== undefined) result.minLength = prop.minLength;
    if (prop.maxLength !== undefined) result.maxLength = prop.maxLength;
    if (prop.items) {
      result.items = {};
      if (prop.items.$ref) result.items.$ref = prop.items.$ref.replace('#/components/schemas/', '');
      else if (prop.items.type) result.items.type = mapType(prop.items.type);
    }
  }

  if (isRequired) result.required = true;
  if (prop.default !== undefined) result.default = prop.default;
  if (prop.title) result.title = prop.title;
  if (prop.description) result.description = prop.description;
  return result;
}

function mapType(t) {
  const map = { string: 'string', integer: 'number', number: 'number', boolean: 'boolean', array: 'array', object: 'object' };
  return map[t] || t || 'string';
}

function extractSchema(pathItem, schemas) {
  const post = pathItem?.post;
  if (!post?.requestBody) return null;
  const content = post.requestBody.content;
  if (!content?.['application/json']) return null;
  let schema = content['application/json'].schema;
  if (!schema) return null;
  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, schemas);
    if (!resolved) return null;
    schema = resolved;
  }
  const requiredFields = schema.required || [];
  const properties = schema.properties || {};
  const params = {};
  const defaults = {};
  for (const [name, prop] of Object.entries(properties)) {
    if (name === 'webhook_url') continue;
    const spec = extractProperty(name, prop, schemas, requiredFields);
    params[name] = spec;
    if (spec.default !== undefined) defaults[name] = spec.default;
  }
  return { params, defaults };
}

function inferGroupOf(category) {
  if (!category) return null;
  const c = category.toLowerCase();
  if (c.includes('image') && !c.includes('video')) return 'image';
  if (c.includes('video')) return 'video';
  if (c.includes('audio') || c.includes('music') || c.includes('speech')) return 'audio';
  if (c.includes('3d')) return '3d';
  if (c.includes('text') && !c.includes('image') && !c.includes('video')) return 'text';
  return 'other';
}

function esc(str) {
  if (str === null || str === undefined) return 'NULL';
  return "'" + String(str).replace(/'/g, "''") + "'";
}

function jsonEsc(obj) {
  if (!obj) return 'NULL';
  return esc(JSON.stringify(obj));
}

// Build a lookup map: stripped-name → openapi-path
function buildOpenAPILookup(paths) {
  const lookup = {};
  for (const pathKey of Object.keys(paths)) {
    if (!pathKey.startsWith('/api/v1/') || !paths[pathKey].post) continue;
    const slug = pathKey.replace('/api/v1/', '');
    // Store the full slug
    lookup[slug] = pathKey;
    // Also store stripped versions
    for (const suffix of STRIP_SUFFIXES) {
      if (slug.endsWith(suffix)) {
        const stripped = slug.slice(0, -suffix.length);
        if (!lookup[stripped]) lookup[stripped] = pathKey;
      }
    }
  }
  return lookup;
}

async function main() {
  console.log('=== MuAPI OpenAPI → D1 Seed Generator ===\n');

  // 1. Load OpenAPI spec
  console.log('1. Loading OpenAPI spec...');
  const spec = await getOpenAPISpec();
  const schemas = spec.components?.schemas || {};
  const paths = spec.paths || {};
  console.log(`   Paths: ${Object.keys(paths).length}, Schemas: ${Object.keys(schemas).length}`);

  // Build OpenAPI lookup (stripped-name → path)
  const openAPILookup = buildOpenAPILookup(paths);
  console.log(`   Lookup entries: ${Object.keys(openAPILookup).length}\n`);

  // 2. Load markdown categories
  console.log('2. Loading markdown categories...');
  let mdModels = {};
  if (fs.existsSync(LLMSTXT_PATH)) {
    mdModels = parseMarkdownCategories(fs.readFileSync(LLMSTXT_PATH, 'utf-8'));
    console.log(`   Found ${Object.keys(mdModels).length} models in markdown\n`);
  }

  // 3. Fetch live catalog (PRIMARY SOURCE)
  console.log('3. Fetching live catalog...');
  let catalogModels = [];
  try {
    const res = await fetch('https://api.muapi.ai/api/v1/models');
    if (res.ok) {
      const catalog = await res.json();
      catalogModels = catalog.models || [];
      console.log(`   Got ${catalogModels.length} models\n`);
    }
  } catch (e) {
    console.log('   ERROR: Could not fetch catalog\n');
    process.exit(1);
  }

  // 4. Build SQL
  console.log('4. Building SQL...');
  const stmts = [];
  let modelCount = 0, withParams = 0, matched = 0;
  const categories = {};

  stmts.push('DELETE FROM model_params;');
  stmts.push('DELETE FROM models;');
  stmts.push('DELETE FROM catalog_meta;');
  stmts.push(`INSERT INTO catalog_meta (key, value) VALUES ('last_sync', datetime('now'));`);
  stmts.push(`INSERT INTO catalog_meta (key, value) VALUES ('source', 'catalog+openapi');`);

  for (const catModel of catalogModels) {
    const catalogName = catModel.name;  // e.g. "flux-schnell"
    const endpoint = catModel.endpoint;  // e.g. "/api/v1/flux-schnell"

    // Find matching OpenAPI path
    const openAPIPath = openAPILookup[catalogName] || null;
    const pathItem = openAPIPath ? paths[openAPIPath] : null;

    // Extract schema from OpenAPI if matched
    let schemaResult = null;
    if (pathItem) {
      schemaResult = extractSchema(pathItem, schemas);
      matched++;
    }

    // Category: prefer markdown, then OpenAPI tag, then infer
    const mdCat = mdModels[catalogName]?.category;
    const oapiTag = pathItem?.post?.tags?.[0] || '';
    const category = mdCat || TAG_TO_CATEGORY[oapiTag] || inferGroupOf(catModel.group_of) || 'Other';

    // Description: prefer markdown, then OpenAPI
    const description = (mdModels[catalogName]?.description || pathItem?.post?.description || '').substring(0, 500);

    const groupOf = catModel.group_of || inferGroupOf(category);

    // Use OpenAPI path as the actual API endpoint when available (it's what actually works)
    // The catalog `endpoint` field sometimes differs from the real working endpoint
    const apiEndpoint = openAPIPath || endpoint;

    stmts.push(
      `INSERT OR REPLACE INTO models (id, name, description, category, family, group_of, cost, cost_currency, dynamic_pricing, endpoint, estimate_endpoint, playground_url, llms_txt_url, is_active) VALUES (${esc(catalogName)}, ${esc(catalogName)}, ${esc(description)}, ${esc(category)}, ${esc(catModel.family)}, ${esc(groupOf)}, ${catModel.cost || 0}, '${catModel.cost_currency || 'USD'}', ${catModel.dynamic_pricing ? 1 : 0}, ${esc(apiEndpoint)}, ${esc(catModel.estimate_endpoint)}, ${esc('https://muapi.ai/playground/' + catalogName)}, ${esc('https://muapi.ai/playground/' + catalogName + '/llms.txt')}, 1);`
    );
    modelCount++;

    if (schemaResult && Object.keys(schemaResult.params).length > 0) {
      stmts.push(
        `INSERT OR REPLACE INTO model_params (model_id, schema_json, defaults_json) VALUES (${esc(catalogName)}, ${jsonEsc(schemaResult.params)}, ${jsonEsc(schemaResult.defaults)});`
      );
      withParams++;
    }

    categories[category] = (categories[category] || 0) + 1;
  }

  stmts.push(`INSERT OR REPLACE INTO catalog_meta (key, value, updated_at) VALUES ('total_models', '${modelCount}', datetime('now'));`);

  // 5. Write
  const sql = stmts.join('\n');
  fs.writeFileSync(OUTPUT_SQL, sql, 'utf-8');

  console.log(`   Output: ${OUTPUT_SQL} (${(Buffer.byteLength(sql) / 1024).toFixed(1)} KB)\n`);

  console.log('=== Summary ===');
  console.log(`   Total catalog models: ${modelCount}`);
  console.log(`   Matched to OpenAPI:   ${matched}`);
  console.log(`   With param schemas:   ${withParams}`);
  console.log(`   SQL statements:       ${stmts.length}`);
  console.log('\n   By category:');
  for (const [cat, count] of Object.entries(categories).sort((a, b) => b[1] - a[1])) {
    console.log(`     ${cat}: ${count}`);
  }
  console.log('\n=== Done! ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
