// src/auth/firebase.js
import fs from "fs";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { validateFirebaseCredentialSources } from "../config/runtimeConfig.js";

let initialized = false;

export function initFirebaseAdmin() {
  if (initialized) return;

  let serviceAccountObj = null;

  const credentialSource = validateFirebaseCredentialSources(process.env);
  if (credentialSource === "json") {
    serviceAccountObj = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    const svcPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    serviceAccountObj = JSON.parse(fs.readFileSync(svcPath, "utf8"));
  }

  if (!getApps().some((app) => app.name === "[DEFAULT]")) {
    initializeApp({
      credential: cert(serviceAccountObj),
    });
  }

  initialized = true;
}

export async function verifyFirebaseToken(
  idToken,
  { checkRevoked = true } = {}
) {
  // Normal application authentication must also prove that the Firebase user
  // still exists and that the session was not revoked. Deletion reconciliation
  // uses the signature-only helper below because the user may already be gone.
  return getAuth().verifyIdToken(idToken, checkRevoked);
}

export async function verifyFirebaseTokenSignature(idToken) {
  return verifyFirebaseToken(idToken, { checkRevoked: false });
}

export async function deleteFirebaseUser(uid) {
  return getAuth().deleteUser(uid);
}

export async function getFirebaseUser(uid) {
  return getAuth().getUser(uid);
}
