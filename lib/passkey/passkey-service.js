/**
 * WebAuthn/passkey service for MAIA
 */

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import '@simplewebauthn/server/helpers';
import { isoBase64URL } from "@simplewebauthn/server/helpers";

export class PasskeyService {
  constructor(options = {}) {
    this.rpName = options.rpName || "HIEofOne.org";
    this.rpID = options.rpID || process.env.PASSKEY_RPID || 'localhost';
    this.origin = options.origin || process.env.PASSKEY_ORIGIN || 'http://localhost:3001';
  }

  /**
   * Generate registration options for a new passkey
   */
  async generateRegistrationOptions(params) {
    const { userId, displayName } = params;

    if (!userId || !displayName) {
      throw new Error('userId and displayName are required');
    }

    // Validate userId format
    if (userId.length < 3) {
      throw new Error('User ID must be at least 3 characters');
    }
    if (userId.length > 20) {
      throw new Error('User ID must be 20 characters or less');
    }
    if (!/^[a-z0-9-]+$/.test(userId)) {
      throw new Error('User ID must contain only lowercase letters, numbers, and hyphens');
    }
    if (userId.startsWith('-') || userId.endsWith('-')) {
      throw new Error('User ID cannot start or end with a hyphen');
    }

    const options = await generateRegistrationOptions({
      rpName: this.rpName,
      rpID: this.rpID,
      userID: Buffer.from(userId, 'utf8'),
      userName: displayName,
      userDisplayName: displayName,
      attestation: "none",
      authenticatorSelection: {
        residentKey: "preferred",
        userVerification: "preferred",
        authenticatorAttachment: "platform",
      },
    });

    return options;
  }

  /**
   * Verify registration response
   */
  async verifyRegistration(params) {
    const { response, expectedChallenge, userDoc } = params;

    if (!response || !expectedChallenge) {
      throw new Error('response and expectedChallenge are required');
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
    });

    if (!verification.verified) {
      throw new Error('Registration verification failed');
    }

    // Build credential info for storage
    const credentialInfo = {
      credentialID: verification.registrationInfo.credential.id,
      credentialPublicKey: isoBase64URL.fromBuffer(verification.registrationInfo.credential.publicKey),
      counter: verification.registrationInfo.credential.counter,
      transports: response.response.transports || [],
    };

    return {
      verified: true,
      credentialInfo,
      userDoc: userDoc ? { ...userDoc, ...credentialInfo } : null
    };
  }

  /**
   * Generate authentication options for passkey login
   */
  async generateAuthenticationOptions(params) {
    const { userId, userDoc } = params;

    if (!userDoc || !userDoc.credentialID) {
      throw new Error('User does not have a registered passkey');
    }

    // Build allowed credential from user doc
    const allowedCredential = {
      id: userDoc.credentialID,
      type: 'public-key',
      transports: userDoc.transports || [],
    };

    const options = await generateAuthenticationOptions({
      rpID: this.rpID,
      allowCredentials: [allowedCredential],
      userVerification: 'preferred',
      timeout: 60000,
      authenticatorSelection: {
        authenticatorAttachment: "platform",
      },
    });

    return options;
  }

  /**
   * Verify authentication response
   */
  async verifyAuthentication(params) {
    const { response, expectedChallenge, userDoc } = params;

    if (!response || !expectedChallenge || !userDoc) {
      throw new Error('response, expectedChallenge, and userDoc are required');
    }

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: {
        id: userDoc.credentialID,
        publicKey: isoBase64URL.toBuffer(userDoc.credentialPublicKey),
        counter: userDoc.counter || 0,
      },
    });

    if (!verification.verified) {
      throw new Error('Authentication verification failed');
    }

    // Update counter
    const updatedUserDoc = {
      ...userDoc,
      counter: verification.authenticationInfo.newCounter,
    };

    return {
      verified: true,
      userDoc: updatedUserDoc,
    };
  }
}

