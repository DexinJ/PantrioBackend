// src/legal/termsPolicy.js
//
// The version recorded with an account is whatever this constant held when the
// row was created. Bump it whenever the published Terms page changes so the
// stored record keeps pointing at the wording the user actually agreed to.

export const CURRENT_TERMS_VERSION = "2026-09-30";

export class TermsAcceptanceRequiredError extends Error {
  constructor(
    message = "Terms acceptance is required to create this account."
  ) {
    super(message);
    this.name = "TermsAcceptanceRequiredError";
    this.code = "TERMS_ACCEPTANCE_REQUIRED";
    this.termsVersion = CURRENT_TERMS_VERSION;
  }
}

// Only an explicit boolean true counts. A truthy string from an old client is
// not evidence that anyone read the Terms.
export function isTermsAccepted(body) {
  return body?.termsAccepted === true;
}
