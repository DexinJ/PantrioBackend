// src/config/env.js
import dotenv from "dotenv";
import {
  parsePort,
  requireNodeEnvironment,
  validateSingleReplicaEnvironment,
} from "./runtimeConfig.js";
import {
  MODEL_RECIPE_ESTIMATION_DEFAULT,
  MODEL_RECIPE_IDEATION_DEFAULT,
} from "./models.js";

dotenv.config();

export const NODE_ENV = requireNodeEnvironment(process.env.NODE_ENV);
process.env.NODE_ENV = NODE_ENV;
export const PORT = parsePort(process.env.PORT);
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const SERPER_API_KEY = process.env.SERPER_API_KEY || "";
export const RECIPE_AI_ESTIMATION_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.RECIPE_AI_ESTIMATION || "")
);
export const RECIPE_ESTIMATION_MODEL =
  String(process.env.RECIPE_ESTIMATION_MODEL || MODEL_RECIPE_ESTIMATION_DEFAULT).trim() ||
  MODEL_RECIPE_ESTIMATION_DEFAULT;
export const RECIPE_IDEATION_ENABLED = /^(1|true|yes)$/i.test(
  String(process.env.RECIPE_IDEATION || "")
);
export const RECIPE_IDEATION_MODEL =
  String(process.env.RECIPE_IDEATION_MODEL || MODEL_RECIPE_IDEATION_DEFAULT).trim() ||
  MODEL_RECIPE_IDEATION_DEFAULT;
// When enabled, every chat round sent to the AI provider is logged as a single
// structured JSON line (with images redacted and long text truncated).
export const LOG_AI_REQUESTS = /^(1|true|yes)$/i.test(
  String(process.env.LOG_AI_REQUESTS || "")
);

validateSingleReplicaEnvironment(process.env);
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
