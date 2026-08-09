import assert from "node:assert/strict";
import test from "node:test";

import {
  SubscriptionPlanConfigurationError,
  parseSubscriptionPlanCatalog,
} from "../src/subscriptions/planCatalog.js";

const basePlan = {
  id: "starter",
  name: "Starter",
  productIds: ["com.chilltech.pantrio.starter.monthly"],
  dailyTokenLimit: 50_000,
  defaultModel: "gpt-5-mini",
  allowedModels: ["gpt-5-mini"],
  maxCompletionTokens: 1_000,
  maxPromptTokens: 25_000,
};

test("parses limited and unlimited subscription capabilities", () => {
  const plans = parseSubscriptionPlanCatalog(
    JSON.stringify([
      basePlan,
      {
        ...basePlan,
        id: "business",
        name: "Business",
        productIds: ["com.chilltech.pantrio.business.yearly"],
        dailyTokenLimit: null,
        defaultModel: "gpt-5",
        allowedModels: ["gpt-5", "gpt-5-mini"],
      },
    ])
  );

  assert.equal(plans[0].dailyTokenLimit, 50_000);
  assert.equal(plans[1].dailyTokenLimit, null);
  assert.equal(plans[1].defaultModel, "gpt-5");
  assert.equal(Object.isFrozen(plans[1].allowedModels), true);
});

test("rejects duplicate products and invalid model capabilities", () => {
  assert.throws(
    () =>
      parseSubscriptionPlanCatalog(
        JSON.stringify([
          basePlan,
          { ...basePlan, id: "other", name: "Other" },
        ])
      ),
    SubscriptionPlanConfigurationError
  );
  assert.throws(
    () =>
      parseSubscriptionPlanCatalog(
        JSON.stringify([
          {
            ...basePlan,
            defaultModel: "invented-model",
            allowedModels: ["invented-model"],
          },
        ])
      ),
    /not supported/
  );
});

