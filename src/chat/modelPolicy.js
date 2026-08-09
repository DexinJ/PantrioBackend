import {
  ALLOWED_MODELS_NON_SUBSCRIBER,
  NON_SUBSCRIBER_CHAT_MODEL,
} from "../config/policy.js";
import { FREE_PLAN, SUBSCRIPTION_PLANS } from "../subscriptions/planCatalog.js";

export function resolveChatModel({ requestedModel, isSubscribed, plan }) {
  const normalizedRequestedModel =
    typeof requestedModel === "string" && requestedModel.trim()
      ? requestedModel.trim()
      : null;

  const effectivePlan = plan || (isSubscribed ? SUBSCRIPTION_PLANS[0] : FREE_PLAN);

  if (effectivePlan.id === FREE_PLAN.id) {
    return {
      ok: true,
      model: NON_SUBSCRIBER_CHAT_MODEL,
      requestedModel: normalizedRequestedModel,
      wasRestricted:
        normalizedRequestedModel !== null &&
        normalizedRequestedModel !== NON_SUBSCRIBER_CHAT_MODEL,
    };
  }

  const model = normalizedRequestedModel || effectivePlan.defaultModel;

  if (!effectivePlan.allowedModels.includes(model)) {
    return {
      ok: false,
      model: null,
      requestedModel: normalizedRequestedModel,
      wasRestricted: false,
      reason: "Model not allowed",
    };
  }

  return {
    ok: true,
    model,
    requestedModel: normalizedRequestedModel,
    wasRestricted: false,
  };
}

export function isNonSubscriberModel(model) {
  return ALLOWED_MODELS_NON_SUBSCRIBER.has(model);
}
