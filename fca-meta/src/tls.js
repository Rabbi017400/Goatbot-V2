"use strict";

// Node's TLS stack does not let a pure-JS client reproduce Chrome's exact JA3
// (extension order + GREASE are not exposed), but the fields that are exposed
// still move the handshake away from Node's default fingerprint. This mirrors
// mautrix-meta's forceHTTP1ChromeFingerprint, which pins ALPN to http/1.1 and
// uses a Chrome uTLS spec, as closely as Node allows.
const CHROME_CIPHERS = [
  "TLS_AES_128_GCM_SHA256",
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "ECDHE-ECDSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "ECDHE-ECDSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
  "ECDHE-ECDSA-CHACHA20-POLY1305",
  "ECDHE-RSA-CHACHA20-POLY1305",
  "ECDHE-RSA-AES128-SHA",
  "ECDHE-RSA-AES256-SHA",
  "AES128-GCM-SHA256",
  "AES256-GCM-SHA384",
  "AES128-SHA",
  "AES256-SHA",
].join(":");

const CHROME_SIGALGS = [
  "ecdsa_secp256r1_sha256",
  "rsa_pss_rsae_sha256",
  "rsa_pkcs1_sha256",
  "ecdsa_secp384r1_sha384",
  "rsa_pss_rsae_sha384",
  "rsa_pkcs1_sha384",
  "rsa_pss_rsae_sha512",
  "rsa_pkcs1_sha512",
].join(":");

const CHROME_ECDH_CURVE = "X25519:P-256:P-384";

// undici connect options that get forwarded to tls.connect.
function chromeConnectOptions() {
  return {
    ALPNProtocols: ["http/1.1"],
    ciphers: CHROME_CIPHERS,
    sigalgs: CHROME_SIGALGS,
    ecdhCurve: CHROME_ECDH_CURVE,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    // Chrome does not resume TLS sessions across new connections.
    sessionTimeout: 0,
  };
}

function buildDispatcher({ proxy } = {}) {
  const undici = require("undici");
  const connect = chromeConnectOptions();
  if (proxy) {
    const { ProxyAgent } = undici;
    return new ProxyAgent({ uri: proxy, connect, proxyTls: connect });
  }
  return new undici.Agent({ connect, pipelining: 0 });
}

module.exports = { chromeConnectOptions, buildDispatcher, CHROME_CIPHERS, CHROME_SIGALGS, CHROME_ECDH_CURVE };
