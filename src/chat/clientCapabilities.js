// Which client-owned tools the connected app build can execute. The client
// advertises these on `start`; a tool is only offered when it is advertised, so
// an older build never receives a call it cannot run.
import { MASS_ADD_SHOPPING_ITEMS_TOOL_NAME } from "./toolNames.js";

export const MASS_ADD_SHOPPING_ITEMS_CAPABILITY =
  MASS_ADD_SHOPPING_ITEMS_TOOL_NAME;

export function filterToolsForClientCapabilities(tools, clientCapabilities) {
  const supported = new Set(
    Array.isArray(clientCapabilities) ? clientCapabilities : []
  );
  if (supported.has(MASS_ADD_SHOPPING_ITEMS_CAPABILITY)) return tools;
  return (Array.isArray(tools) ? tools : []).filter(
    (tool) => tool?.function?.name !== MASS_ADD_SHOPPING_ITEMS_TOOL_NAME
  );
}
