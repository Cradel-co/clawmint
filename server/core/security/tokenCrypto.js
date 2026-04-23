'use strict';

/**
 * tokenCrypto — cifrado simétrico de tokens de auth (MCP OAuth, API keys).
 *
 * - Key derivation: `scrypt` desde una master-key (env `MCP_TOKEN_ENCRYPTION_KEY`
 *   o auto-generada al primer arranque + persistida con permissions 600).
 * - Algoritmo: `aes-256-gcm` (autenticado, detecta tampering).
 * - Formato encrypted: `base64(salt || iv || authTag || ciphertext)` — un único string.
 *
 * Uso:
 *   const crypto = new TokenCrypto({ masterKey });
 *   const enc = crypto.encrypt('sk-ant-secret-123');
 *   const dec = crypto.decrypt(enc);
 *
 * Si masterKey no está disponible, `encrypt/decrypt` fallan explícitamente
 * (no fallback a plaintext — Fase 5.75 audit requiere cifrado real).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;      // 256 bits
const IV_LEN = 12;       // GCM recommendation
const SALT_LEN = 16;
const TAG_LEN = 16;
const SCRYPT_COST = 16_384;

class TokenCrypto {
  /**
   * @param {object} opts
   * @param {string} [opts.masterKey]     — string raw; si no se pasa, se lee env MCP_TOKEN_ENCRYPTION_KEY
   * @param {string} [opts.keyFilePath]   — path al file con master-key generada (auto-create)
   * @param {object} [opts.logger]
   */
  constructor({ masterKey, keyFilePath, logger = console } = {}) {
    this._logger = logger;
    this._masterKey = masterKey || process.env.MCP_TOKEN_ENCRYPTION_KEY || null;
    const { CONFIG_FILES } = require('../../paths');
    this._keyFilePath = keyFilePath || CONFIG_FILES.tokenMasterKey;
    if (!this._masterKey) {
      this._masterKey = this._loadOrGenerateMasterKey();
    }
  }

  _loadOrGenerateMasterKey() {
    try {
      if (fs.existsSync(this._keyFilePath)) {
        return fs.readFileSync(this._keyFilePath, 'utf8').trim();
      }
    } catch (err) {
      this._logger.warn && this._logger.warn(`[tokenCrypto] no pude leer key file: ${err.message}`);
    }
    // Auto-generar + persistir con permissions 600
    const key = crypto.randomBytes(KEY_LEN).toString('hex');
    try {
      fs.writeFileSync(this._keyFilePath, key, { mode: 0o600 });
      this._logger.info && this._logger.info(`[tokenCrypto] master key auto-generada → ${this._keyFilePath}`);
    } catch (err) {
      this._logger.warn && this._logger.warn(`[tokenCrypto] no pude persistir key: ${err.message}. Cifrado funcional pero se perderá al reiniciar.`);
    }
    return key;
  }

  _deriveKey(salt) {
    return crypto.scryptSync(this._masterKey, salt, KEY_LEN, { N: SCRYPT_COST });
  }

  /**
   * Cifra un string plaintext. Retorna un único blob base64 con salt+iv+tag+ciphertext.
   * @param {string} plaintext
   * @returns {string}
   */
  encrypt(plaintext) {
    if (!this._masterKey) throw new Error('tokenCrypto: master key no disponible');
    if (typeof plaintext !== 'string') throw new Error('plaintext debe ser string');

    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const key = this._deriveKey(salt);

    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
  }

  /**
   * Descifra un blob generado por `encrypt()`.
   * @param {string} encoded — base64 del blob
   * @returns {string} plaintext
   */
  decrypt(encoded) {
    if (!this._masterKey) throw new Error('tokenCrypto: master key no disponible');
    if (typeof encoded !== 'string') throw new Error('encoded debe ser string');

    const buf = Buffer.from(encoded, 'base64');
    if (buf.length < SALT_LEN + IV_LEN + TAG_LEN) throw new Error('blob cifrado demasiado corto');

    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const ciphertext = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);

    const key = this._deriveKey(salt);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

module.exports = TokenCrypto;
