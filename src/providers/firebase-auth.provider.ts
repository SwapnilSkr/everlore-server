import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose'
import { env } from '../config/env'
import { HttpError } from '../utils/http-error'

/**
 * Google's public keys for Firebase ID tokens.
 *
 * `createRemoteJWKSet` caches the key set and re-fetches on an unknown `kid`,
 * which is what makes Google's key rotation a non-event for us.
 */
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

/** What a verified Firebase sign-in tells us about the player. */
export interface VerifiedFirebaseProfile {
  /** Firebase's own account id. Stable per Firebase project. */
  firebaseUid: string
  /**
   * The Google account id — the same `sub` the old raw Google Sign-In flow
   * recorded, lifted back out of the Firebase token.
   *
   * This is the whole reason the migration does not orphan anybody. Firebase
   * mints its own `sub` (the UID), which has no relationship to the Google
   * `sub` already stored on every existing account. Matching on the UID would
   * strand every player who ever signed in with Google behind a brand new,
   * empty account. Firebase carries the original identity in
   * `firebase.identities['google.com']`, so we key on that and existing rows
   * keep matching exactly as before.
   */
  googleSubject: string
  email: string
  name?: string
  picture?: string
}

export interface FirebaseTokenPayload extends JWTPayload {
  email?: string
  email_verified?: boolean
  name?: string
  picture?: string
  firebase?: {
    sign_in_provider?: string
    identities?: Record<string, unknown>
  }
}

/**
 * Verify a Firebase ID token minted for this project by a Google sign-in.
 *
 * Replaces the previous call to Google's `tokeninfo` endpoint. Two things
 * improve: the signature is checked locally against Google's published keys
 * rather than by asking a network service to vouch for the string, and the
 * check is a real JWT verification (`exp`, `iat`, `iss`, `aud`, RS256) instead
 * of trusting a JSON body.
 */
export async function verifyFirebaseIdToken(
  idToken: string,
  /**
   * Where to get the signing keys. Defaults to Google's published set; the
   * audit passes a locally generated one so it can sign tokens and exercise
   * this function for real.
   *
   * This is a seam, not a bypass: there is no value it can take that makes an
   * unsigned or wrongly-signed token pass, and production never supplies it.
   */
  keyStore: JWTVerifyGetKey = FIREBASE_JWKS,
): Promise<VerifiedFirebaseProfile> {
  const projectId = env.FIREBASE_PROJECT_ID
  if (!projectId) throw new HttpError(503, 'Google sign-in is not configured on this server')

  let payload: FirebaseTokenPayload
  try {
    const verified = await jwtVerify(idToken, keyStore, {
      algorithms: ['RS256'],
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    payload = verified.payload as FirebaseTokenPayload
  } catch {
    // Never surface the library's reason: it distinguishes expired from
    // malformed from wrong-audience, which tells an attacker which knob to
    // turn. The player cannot act on the difference either way.
    throw new HttpError(401, 'Invalid Google sign-in')
  }

  return profileFromFirebaseClaims(payload)
}

/**
 * The claim rules, split out from signature checking so they can be exercised
 * directly. `jwtVerify` above already established that Google signed this token
 * for this project and that it has not expired; everything here is about
 * whether the *contents* describe a Google sign-in we will accept.
 *
 * Run `bun run audit:firebase-auth` to exercise these.
 */
export function profileFromFirebaseClaims(payload: FirebaseTokenPayload): VerifiedFirebaseProfile {
  const firebaseUid = typeof payload.sub === 'string' ? payload.sub : ''
  if (!firebaseUid) throw new HttpError(401, 'Invalid Google sign-in')

  // This endpoint means "I signed in with Google". A token minted for any other
  // provider on this project — anonymous, phone, a provider added later — is a
  // perfectly valid Firebase token with a good signature, and must still be
  // refused here. Without this check, enabling anonymous sign-in in the console
  // one day would silently become a way to claim a Google-linked account
  // without holding the Google account.
  const identities = payload.firebase?.identities || {}
  const googleIdentities = identities['google.com']
  const googleSubject = Array.isArray(googleIdentities) ? String(googleIdentities[0] ?? '') : ''
  if (payload.firebase?.sign_in_provider !== 'google.com' || !googleSubject) {
    throw new HttpError(401, 'This sign-in did not come from a Google account')
  }

  const email = typeof payload.email === 'string' ? payload.email : ''
  if (!email) throw new HttpError(401, 'Google account is missing an email address')
  // Accounts are matched on email as well as subject, so an unverified address
  // would let somebody sign up with a Google account bearing a stranger's email
  // and be handed that stranger's existing row.
  if (payload.email_verified !== true) {
    throw new HttpError(401, 'Google account email is not verified')
  }

  return {
    firebaseUid,
    googleSubject,
    email,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  }
}
