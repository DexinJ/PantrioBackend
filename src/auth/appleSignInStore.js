export class AppleSignInCredentialConflictError extends Error {
  constructor() {
    super("This Apple account is already linked to a different app account.");
    this.name = "AppleSignInCredentialConflictError";
    this.code = "APPLE_IDENTITY_CONFLICT";
  }
}

export async function getAppleSignInCredential(db, uid) {
  if (!uid) return null;

  return db.get(
    `SELECT firebase_uid, apple_subject, client_id, encrypted_refresh_token,
            created_at, updated_at
       FROM apple_sign_in_credentials
      WHERE firebase_uid = ?`,
    [uid]
  );
}

export async function saveAppleSignInCredential(db, credential) {
  const existingSubject = await db.get(
    `SELECT firebase_uid
       FROM apple_sign_in_credentials
      WHERE client_id = ? AND apple_subject = ?`,
    [credential.clientId, credential.appleSubject]
  );

  if (
    existingSubject &&
    existingSubject.firebase_uid !== credential.uid
  ) {
    throw new AppleSignInCredentialConflictError();
  }

  const existingUser = await getAppleSignInCredential(db, credential.uid);
  if (
    existingUser &&
    (existingUser.apple_subject !== credential.appleSubject ||
      existingUser.client_id !== credential.clientId)
  ) {
    throw new AppleSignInCredentialConflictError();
  }

  const now = Date.now();

  try {
    await db.run(
      `INSERT INTO apple_sign_in_credentials (
         firebase_uid, apple_subject, client_id, encrypted_refresh_token,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(firebase_uid) DO UPDATE SET
         encrypted_refresh_token = excluded.encrypted_refresh_token,
         client_id = excluded.client_id,
         updated_at = excluded.updated_at
       WHERE apple_sign_in_credentials.apple_subject = excluded.apple_subject`,
      [
        credential.uid,
        credential.appleSubject,
        credential.clientId,
        credential.encryptedRefreshToken,
        now,
        now,
      ]
    );
  } catch (error) {
    if (String(error?.code || "").includes("CONSTRAINT")) {
      throw new AppleSignInCredentialConflictError();
    }
    throw error;
  }

  const saved = await getAppleSignInCredential(db, credential.uid);
  if (!saved || saved.apple_subject !== credential.appleSubject) {
    throw new AppleSignInCredentialConflictError();
  }

  return saved;
}
