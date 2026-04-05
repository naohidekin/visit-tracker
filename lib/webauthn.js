'use strict';
// WebAuthn 資格情報管理モジュール（FIDO2/生体認証）

const { isoBase64URL } = require('@simplewebauthn/server/helpers');
const { loadWebAuthnData, saveWebAuthnData } = require('./data');

async function loadCredentials(staffId) {
  const data = loadWebAuthnData();
  return data.credentials
    .filter(c => c.staffId === staffId)
    .map(c => ({
      id: c.credentialID,
      publicKey: isoBase64URL.toBuffer(c.publicKey),
      counter: c.counter,
      transports: c.transports || [],
    }));
}

async function saveCredential(staffId, credential) {
  const data = loadWebAuthnData();
  data.credentials.push({
    staffId,
    credentialID: credential.id,
    publicKey: isoBase64URL.fromBuffer(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports || [],
    registeredAt: new Date().toISOString(),
  });
  saveWebAuthnData(data);
}

async function updateCredentialCounter(credentialID, newCounter) {
  const data = loadWebAuthnData();
  const cred = data.credentials.find(c => c.credentialID === credentialID);
  if (cred) {
    cred.counter = newCounter;
    saveWebAuthnData(data);
  }
}

async function deleteCredentials(staffId) {
  const data = loadWebAuthnData();
  data.credentials = data.credentials.filter(c => c.staffId !== staffId);
  saveWebAuthnData(data);
}

async function hasCredentials(staffId) {
  try {
    const creds = await loadCredentials(staffId);
    return creds.length > 0;
  } catch { return false; }
}

function getWebAuthnRpId(req) {
  return req.hostname;
}

function getWebAuthnOrigin(req) {
  // localhost は http 許可、本番は https
  const proto = req.hostname === 'localhost' ? 'http' : 'https';
  const port = req.hostname === 'localhost' && process.env.PORT ? `:${process.env.PORT}` : '';
  return `${proto}://${req.hostname}${port}`;
}

module.exports = {
  loadCredentials,
  saveCredential,
  updateCredentialCounter,
  deleteCredentials,
  hasCredentials,
  getWebAuthnRpId,
  getWebAuthnOrigin,
};
