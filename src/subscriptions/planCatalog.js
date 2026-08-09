import {
  ALLOWED_MODELS_AUTHED,
  NON_SUBSCRIBER_CHAT_MODEL,
  NON_SUBSCRIBER_MAX_COMPLETION_TOKENS,
  NON_SUBSCRIBER_TOKENS_PER_DAY,
  SUBSCRIBER_MAX_COMPLETION_TOKENS,
  SUBSCRIBER_MAX_PROMPT_TOKENS,
} from "../config/policy.js";

const PLAN_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,254}$/;

export const FREE_PLAN = Object.freeze({
  id: "free",
  name: "Free",
  productIds: Object.freeze([]),
  dailyTokenLimit: NON_SUBSCRIBER_TOKENS_PER_DAY,
  defaultModel: NON_SUBSCRIBER_CHAT_MODEL,
  allowedModels: Object.freeze([NON_SUBSCRIBER_CHAT_MODEL]),
  maxCompletionTokens: NON_SUBSCRIBER_MAX_COMPLETION_TOKENS,
  maxPromptTokens: NON_SUBSCRIBER_TOKENS_PER_DAY,
});

const DEFAULT_PAID_PLANS = Object.freeze([
  Object.freeze({
    id: "pro",
    name: "Pantrio Pro",
    productIds: Object.freeze([
      "com.chilltech.pantrio.subscription.monthly",
      "com.chilltech.pantrio.subscription.yearly",
    ]),
    dailyTokenLimit: null,
    defaultModel: "gpt-5",
    allowedModels: Object.freeze([...ALLOWED_MODELS_AUTHED]),
    maxCompletionTokens: SUBSCRIBER_MAX_COMPLETION_TOKENS,
    maxPromptTokens: SUBSCRIBER_MAX_PROMPT_TOKENS,
  }),
]);

export class SubscriptionPlanConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SubscriptionPlanConfigurationError";
    this.code = "INVALID_SUBSCRIPTION_PLAN_CONFIGURATION";
  }
}

function configurationError(message) {
  throw new SubscriptionPlanConfigurationError(message);
}

function requirePositiveInteger(value, field, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    configurationError(`${field} must be a positive integer${nullable ? " or null" : ""}`);
  }
  return value;
}

function normalizePlan(rawPlan, index) {
  if (!rawPlan || typeof rawPlan !== "object" || Array.isArray(rawPlan)) {
    configurationError(`plans[${index}] must be an object`);
  }

  const id = typeof rawPlan.id === "string" ? rawPlan.id.trim() : "";
  if (!PLAN_ID.test(id) || id === FREE_PLAN.id) {
    configurationError(
      `plans[${index}].id must be a lowercase plan identifier other than "free"`
    );
  }

  const name = typeof rawPlan.name === "string" ? rawPlan.name.trim() : "";
  if (!name || name.length > 80) {
    configurationError(`plans[${index}].name must contain 1-80 characters`);
  }

  if (!Array.isArray(rawPlan.productIds) || rawPlan.productIds.length === 0) {
    configurationError(`plans[${index}].productIds must be a non-empty array`);
  }
  const productIds = rawPlan.productIds.map((value, productIndex) => {
    const productId = typeof value === "string" ? value.trim() : "";
    if (!PRODUCT_ID.test(productId)) {
      configurationError(
        `plans[${index}].productIds[${productIndex}] is not a valid product identifier`
      );
    }
    return productId;
  });
  if (new Set(productIds).size !== productIds.length) {
    configurationError(`plans[${index}].productIds contains a duplicate`);
  }

  if (!Array.isArray(rawPlan.allowedModels) || rawPlan.allowedModels.length === 0) {
    configurationError(`plans[${index}].allowedModels must be a non-empty array`);
  }
  const allowedModels = rawPlan.allowedModels.map((value, modelIndex) => {
    const model = typeof value === "string" ? value.trim() : "";
    if (!ALLOWED_MODELS_AUTHED.has(model)) {
      configurationError(
        `plans[${index}].allowedModels[${modelIndex}] is not supported by this server`
      );
    }
    return model;
  });
  if (new Set(allowedModels).size !== allowedModels.length) {
    configurationError(`plans[${index}].allowedModels contains a duplicate`);
  }

  const defaultModel =
    typeof rawPlan.defaultModel === "string" ? rawPlan.defaultModel.trim() : "";
  if (!allowedModels.includes(defaultModel)) {
    configurationError(`plans[${index}].defaultModel must be in allowedModels`);
  }

  return Object.freeze({
    id,
    name,
    productIds: Object.freeze(productIds),
    dailyTokenLimit: requirePositiveInteger(
      rawPlan.dailyTokenLimit,
      `plans[${index}].dailyTokenLimit`,
      { nullable: true }
    ),
    defaultModel,
    allowedModels: Object.freeze(allowedModels),
    maxCompletionTokens: requirePositiveInteger(
      rawPlan.maxCompletionTokens,
      `plans[${index}].maxCompletionTokens`
    ),
    maxPromptTokens: requirePositiveInteger(
      rawPlan.maxPromptTokens,
      `plans[${index}].maxPromptTokens`
    ),
  });
}

export function parseSubscriptionPlanCatalog(
  rawJson,
  { fallbackPlans = DEFAULT_PAID_PLANS } = {}
) {
  let rawPlans = fallbackPlans;
  if (typeof rawJson === "string" && rawJson.trim()) {
    try {
      rawPlans = JSON.parse(rawJson);
    } catch (error) {
      configurationError(
        `APPLE_SUBSCRIPTION_PLANS_JSON must be valid JSON: ${error.message}`
      );
    }
  }

  if (!Array.isArray(rawPlans) || rawPlans.length === 0) {
    configurationError("the subscription plan catalog must contain at least one paid plan");
  }

  const plans = rawPlans.map(normalizePlan);
  const ids = new Set();
  const productIds = new Set();
  for (const plan of plans) {
    if (ids.has(plan.id)) configurationError(`duplicate plan id: ${plan.id}`);
    ids.add(plan.id);
    for (const productId of plan.productIds) {
      if (productIds.has(productId)) {
        configurationError(`product id is assigned to multiple plans: ${productId}`);
      }
      productIds.add(productId);
    }
  }

  return Object.freeze(plans);
}

export const SUBSCRIPTION_PLANS = parseSubscriptionPlanCatalog(
  process.env.APPLE_SUBSCRIPTION_PLANS_JSON
);

const PLAN_BY_ID = new Map(SUBSCRIPTION_PLANS.map((plan) => [plan.id, plan]));
const PLAN_BY_PRODUCT_ID = new Map(
  SUBSCRIPTION_PLANS.flatMap((plan) =>
    plan.productIds.map((productId) => [productId, plan])
  )
);

export function getPlanById(planId) {
  return planId === FREE_PLAN.id ? FREE_PLAN : PLAN_BY_ID.get(planId) || null;
}

export function getPlanByProductId(productId) {
  return PLAN_BY_PRODUCT_ID.get(productId) || null;
}

export function getPlanCatalogPriority(planId) {
  const index = SUBSCRIPTION_PLANS.findIndex((plan) => plan.id === planId);
  return index < 0
    ? Number.MAX_SAFE_INTEGER
    : SUBSCRIPTION_PLANS.length - 1 - index;
}

export function getPublicAppleProducts() {
  return SUBSCRIPTION_PLANS.flatMap((plan) =>
    plan.productIds.map((productId) => ({
      productId,
      planId: plan.id,
      displayName: plan.name,
    }))
  );
}
