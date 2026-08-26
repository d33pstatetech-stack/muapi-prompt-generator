-- Prompt enhancer persistence (KISS: extend D1, mirrors local data/prompts.json)
CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT CHECK(kind IN ('raw','enhanced','ai')) NOT NULL,
  prompt TEXT NOT NULL,
  enhanced TEXT,
  model_id TEXT,
  params_json TEXT,
  llm_provider TEXT,
  llm_model TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_prompts_kind ON prompts(kind);
CREATE INDEX IF NOT EXISTS idx_prompts_model ON prompts(model_id);
CREATE INDEX IF NOT EXISTS idx_prompts_created ON prompts(created_at DESC);

CREATE TABLE IF NOT EXISTS llm_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  json TEXT NOT NULL,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
