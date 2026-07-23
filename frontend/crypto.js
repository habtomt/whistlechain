/**
 * WhistleChain cryptography helpers.
 *
 * Hash algorithm: SHA-256 (via window.crypto.subtle.digest), matching the
 * on-chain commitment stored as a bytes32 in ReportRegistry.submitReport.
 *
 * Encryption algorithm: AES-256-GCM (via window.crypto.subtle).
 *
 * ON-CHAIN STORAGE: both the SHA-256 hash AND the AES-256-GCM ciphertext
 * (plus its IV) are submitted directly to ReportRegistry.submitReport() and
 * stored in contract storage. There is no off-chain content store in this design.
 */

function bufToBase64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function base64ToBuf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Converts a Uint8Array/ArrayBuffer to a 0x-prefixed hex string (for on-chain `bytes` params). */
function bufToHex(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  return "0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Converts a 0x-prefixed hex string (as returned by ethers for `bytes`) back to a Uint8Array. */
function hexToBuf(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  return bytes.buffer;
}

/** Canonicalizes report fields into a single deterministic string before hashing. */
function canonicalizeReport({ title, description, category, timestamp }) {
  const obj = {
    title: (title || "").trim(),
    description: (description || "").trim(),
    category: (category || "").trim(),
    timestamp: timestamp, // caller-supplied ISO string, fixed at submission time
  };
  // Deterministic key order guarantees the same object always canonicalizes
  // to the same string, which is required for a stable commitment hash.
  return JSON.stringify(obj, ["title", "description", "category", "timestamp"]);
}

/** Returns a 0x-prefixed SHA-256 hex hash of the canonical report string. */
async function sha256Hex(canonicalString) {
  const enc = new TextEncoder().encode(canonicalString);
  const digest = await window.crypto.subtle.digest("SHA-256", enc);
  return bufToHex(digest);
}

/** Generates a fresh AES-256-GCM key and returns it as a base64 string. */
async function generateEncryptionKey() {
  const key = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const raw = await window.crypto.subtle.exportKey("raw", key);
  return bufToBase64(raw);
}

async function importKey(base64Key) {
  const raw = base64ToBuf(base64Key);
  return window.crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts plaintext with AES-256-GCM and returns hex-encoded values ready
 * to pass directly as the `encryptedContent` / `encryptionIv` bytes
 * parameters of ReportRegistry.submitReport().
 */
async function encryptText(plaintext, base64Key) {
  const key = await importKey(base64Key);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder().encode(plaintext);
  const ciphertext = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc);
  return { ciphertextHex: bufToHex(ciphertext), ivHex: bufToHex(iv) };
}

/**
 * Decrypts ciphertext read back from on-chain storage (hex strings as
 * returned by ethers.js for Solidity `bytes` fields).
 */
async function decryptHex(ciphertextHex, ivHex, base64Key) {
  const key = await importKey(base64Key);
  const iv = new Uint8Array(hexToBuf(ivHex));
  const ciphertext = hexToBuf(ciphertextHex);
  const plainBuf = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return new TextDecoder().decode(plainBuf);
}
