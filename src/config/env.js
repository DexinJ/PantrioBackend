// src/config/env.js
import dotenv from "dotenv";
import {
  parsePort,
  requireNodeEnvironment,
  validateSingleReplicaEnvironment,
} from "./runtimeConfig.js";

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
  String(process.env.RECIPE_ESTIMATION_MODEL || "gpt-4o-mini").trim() ||
  "gpt-4o-mini";

validateSingleReplicaEnvironment(process.env);
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
