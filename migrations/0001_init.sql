-- Model catalog from MuAPI live API
CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,              -- model slug (e.g. "flux-dev-image")
  name TEXT NOT NULL,               -- display name
  description TEXT,
  category TEXT NOT NULL,           -- "Text to Image", "Text to Video", etc.
  family TEXT,                      -- "flux", "kling-v2.1", "veo", "seedance-2.5", etc.
  group_of TEXT,                    -- "image", "video", "avatar", "audio", "3d"
  cost REAL,                        -- USD per call (base)
  cost_currency TEXT DEFAULT 'USD',
  dynamic_pricing INTEGER DEFAULT 0, -- 1 if cost varies by params
  endpoint TEXT NOT NULL,           -- "/api/v1/flux-dev-image"
  estimate_endpoint TEXT,           -- "/api/v1/models/flux-dev-image/estimate-cost"
  playground_url TEXT,              -- "https://muapi.ai/playground/flux-dev"
  llms_txt_url TEXT,                -- "https://muapi.ai/playground/flux-dev/llms.txt"
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_models_category ON models(category);
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family);
CREATE INDEX IF NOT EXISTS idx_models_group_of ON models(group_of);
CREATE INDEX IF NOT EXISTS idx_models_name ON models(name);

-- Model-specific parameter schemas (JSON)
CREATE TABLE IF NOT EXISTS model_params (
  model_id TEXT PRIMARY KEY REFERENCES models(id),
  schema_json TEXT NOT NULL,        -- full JSON schema of accepted params
  defaults_json TEXT,               -- default values
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- User saved prompts (client-side for now, but schema ready)
CREATE TABLE IF NOT EXISTS saved_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL,
  prompt_text TEXT NOT NULL,
  params_json TEXT,
  tags TEXT,                        -- comma-separated
  created_at TEXT DEFAULT (datetime('now'))
);

-- Cached catalog metadata
CREATE TABLE IF NOT EXISTS catalog_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);
