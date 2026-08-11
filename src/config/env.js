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

validateSingleReplicaEnvironment(process.env);
if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY in .env");
