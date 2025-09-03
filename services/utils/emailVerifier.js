// emailVerifier.js
// Node 18+, run with: node emailVerifier.js someone@example.com

import { promises as dns } from "dns";
import net from "net";
import { randomBytes } from "crypto";
import punycode from "punycode";
// import SMTPConnection from "smtp-connection"; // Using native net module instead

const DEFAULT_OPTS = {
  heloHost: "validator.local",
  mailFrom: "postmaster@validator.local",
  connectionTimeoutMs: 8000,
  commandTimeoutMs: 8000,
  smtpPort: 25,
  tryStartTLS: true,
  catchAllProbe: true,
};

const ROLE_PREFIXES = new Set([
  "admin",
  "administrator",
  "postmaster",
  "webmaster",
  "hostmaster",
  "abuse",
  "noreply",
  "no-reply",
  "support",
  "help",
  "sales",
  "info",
  "billing",
]);

// --- 1) Normalize -----------------------------------------------------------
export function normalizeEmail(raw) {
  const trimmed = String(raw || "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1)
    return { ok: false, reason: "missing-at" };

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  // IDN: Unicode domain → ASCII (punycode)
  let asciiDomain;
  try {
    asciiDomain = domain.split(".").map(punycode.toASCII).join(".");
  } catch {
    return { ok: false, reason: "bad-idn" };
  }

  return {
    ok: true,
    local,
    domain: asciiDomain.toLowerCase(), // domain is case-insensitive
    address: `${local}@${asciiDomain.toLowerCase()}`,
  };
}

// --- 2) Syntax / length checks (lightweight, pragmatic) ---------------------
export function basicSyntaxCheck(local, domain) {
  // RFC caps (practical): total <= 254, local <= 64, each label <= 63
  const total = `${local}@${domain}`;
  if (total.length > 254) return { ok: false, reason: "too-long" };
  if (local.length === 0 || local.length > 64)
    return { ok: false, reason: "bad-local-length" };
  if (domain.length === 0) return { ok: false, reason: "empty-domain" };
  if (domain.split(".").some((lbl) => lbl.length === 0 || lbl.length > 63)) {
    return { ok: false, reason: "bad-domain-label" };
  }

  // Very permissive local-part: quoted or dot-atom (avoids brittle mega-regex)
  const dotAtom =
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const quoted = /^"([\s\S]|\\")+"$/;
  if (!(dotAtom.test(local) || quoted.test(local))) {
    return { ok: false, reason: "bad-local-syntax" };
  }

  // Domain characters
  const domainRe = /^(?=.{1,253}$)([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
  if (!domainRe.test(domain)) return { ok: false, reason: "bad-domain-syntax" };

  return { ok: true };
}

// --- 3) DNS (MX, then A/AAAA fallback per RFC) ------------------------------
export async function resolveMailHosts(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) {
      return mx.sort((a, b) => a.priority - b.priority).map((r) => r.exchange);
    }
  } catch {}
  // No MX: fallback to A/AAAA (not all servers accept mail on bare A, but RFC allows)
  const hosts = new Set();
  try {
    (await dns.resolve4(domain)).forEach(() => hosts.add(domain));
  } catch {}
  try {
    (await dns.resolve6(domain)).forEach(() => hosts.add(domain));
  } catch {}
  return Array.from(hosts);
}

// --- 4) SMTP callout --------------------------------------------------------
async function withTimeout(promise, ms, label) {
  let to;
  const timeout = new Promise(
    (_, rej) => (to = setTimeout(() => rej(new Error(`${label}-timeout`)), ms))
  );
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(to);
  }
}

async function smtpCheckAddress(host, email, opts) {
  const res = { host, code: null, stage: null, message: null };

  return withTimeout(
    new Promise((resolve) => {
      const socket = net.createConnection(opts.smtpPort, host);
      let response = "";
      let step = 0;

      const cleanup = () => {
        try {
          socket.destroy();
        } catch {}
      };

      const done = (payload) => {
        cleanup();
        resolve({ ...res, ...payload });
      };

      socket.on("error", (err) => {
        done({ stage: "connect", message: err.message });
      });

      socket.on("timeout", () => {
        done({ stage: "connect", message: "connection timeout" });
      });

      socket.on("data", (data) => {
        response += data.toString();

        if (response.includes("\n")) {
          const lines = response.split("\n");
          const lastLine = lines[lines.length - 2] || lines[lines.length - 1];
          const code = parseInt(lastLine.substring(0, 3));

          switch (step) {
            case 0: // Initial greeting
              if (code === 220) {
                step = 1;
                socket.write(`HELO ${opts.heloHost}\r\n`);
              } else {
                done({ stage: "greeting", code, message: lastLine });
              }
              break;

            case 1: // HELO response
              if (code === 250) {
                step = 2;
                socket.write(`MAIL FROM:<${opts.mailFrom}>\r\n`);
              } else {
                done({ stage: "HELO", code, message: lastLine });
              }
              break;

            case 2: // MAIL FROM response
              if (code === 250) {
                step = 3;
                socket.write(`RCPT TO:<${email}>\r\n`);
              } else {
                done({ stage: "MAIL FROM", code, message: lastLine });
              }
              break;

            case 3: // RCPT TO response
              socket.write("QUIT\r\n");
              done({ stage: "RCPT TO", code, message: lastLine });
              break;
          }

          response = "";
        }
      });

      socket.setTimeout(opts.connectionTimeoutMs);
    }),
    opts.commandTimeoutMs,
    "smtp"
  );
}

function randomLocal() {
  return `validator_${randomBytes(6).toString("hex")}`;
}

async function checkCatchAll(host, domain, opts) {
  const probe = `${randomLocal()}@${domain}`;
  const r = await smtpCheckAddress(host, probe, opts);
  // 250 for garbage local-part strongly suggests catch-all (not 100%).
  return r.code === 250;
}

// --- 5) Disposable domains (tiny demo list + a hook to extend) -------------
const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "tempmailo.com",
]);
export function isDisposable(domain) {
  return DISPOSABLE.has(domain);
}

// --- 6) Public API ----------------------------------------------------------
export async function verifyEmail(rawEmail, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };
  const normalized = normalizeEmail(rawEmail);
  if (!normalized.ok) {
    return {
      input: rawEmail,
      result: "undeliverable",
      reason: normalized.reason,
    };
  }
  const { local, domain, address } = normalized;

  const syntax = basicSyntaxCheck(local, domain);
  if (!syntax.ok) {
    return {
      input: rawEmail,
      normalized: address,
      result: "undeliverable",
      reason: syntax.reason,
    };
  }

  const role = ROLE_PREFIXES.has(local.toLowerCase());
  const disposable = isDisposable(domain);

  const hosts = await resolveMailHosts(domain);
  if (!hosts.length) {
    return {
      input: rawEmail,
      normalized: address,
      result: "undeliverable",
      reason: "no-mail-exchanger",
      roleAccount: role,
      disposableDomain: disposable,
    };
  }

  const smtpTried = [];
  let accepted = false;
  let finalCode = null;
  let finalMsg = null;
  let catchAll = null;

  for (const host of hosts) {
    const r = await smtpCheckAddress(host, address, opts);
    smtpTried.push(r);
    finalCode = r.code;
    finalMsg = r.message;

    if (r.code === 250) {
      accepted = true;
      if (opts.catchAllProbe) {
        try {
          catchAll = await checkCatchAll(host, domain, opts);
        } catch {
          catchAll = null;
        }
      }
      break; // good enough
    }
    // 450/451/452 etc → transient; try next MX
    if ([450, 451, 452, 421, 421].includes(r.code)) continue;
  }

  // Decide status
  if (accepted) {
    return {
      input: rawEmail,
      normalized: address,
      result: catchAll ? "risky" : "deliverable",
      reason: catchAll ? "catch-all-domain" : "accepted",
      smtp: smtpTried,
      roleAccount: role,
      disposableDomain: disposable,
      catchAll,
    };
  }

  if ([450, 451, 452, 421].includes(finalCode)) {
    return {
      input: rawEmail,
      normalized: address,
      result: "risky",
      reason: `temporary-failure:${finalCode}`,
      smtp: smtpTried,
      roleAccount: role,
      disposableDomain: disposable,
      catchAll,
    };
  }

  return {
    input: rawEmail,
    normalized: address,
    result: "undeliverable",
    reason: finalMsg || "rejected",
    smtp: smtpTried,
    roleAccount: role,
    disposableDomain: disposable,
    catchAll,
  };
}

// --- CLI --------------------------------------------------------------------
const isMainModule =
  process.argv[1] &&
  (process.argv[1] === new URL(import.meta.url).pathname ||
    process.argv[1].endsWith("emailVerifier.js"));
if (isMainModule) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node emailVerifier.js someone@example.com");
    process.exit(2);
  }
  verifyEmail(email)
    .then((r) => {
      console.log(JSON.stringify(r, null, 2));
      process.exit(r.result === "deliverable" ? 0 : 1);
    })
    .catch((err) => {
      console.error(err);
      process.exit(2);
    });
}
