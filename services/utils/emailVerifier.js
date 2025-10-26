// utils/emailVerifier.js
// Node 18+, ESM. Run: node utils/emailVerifier.js someone@example.com
import dotenv from "dotenv";
dotenv.config();
import { promises as dns } from "dns";
import net from "net";
import tls from "tls";
import { randomBytes } from "crypto";
import { toASCII } from "punycode";

// ---------------------------------------------------------------------------
// Defaults & constants
// ---------------------------------------------------------------------------
const DEFAULT_OPTS = {
  heloHost: process.env.HELO_HOST || "verifier.local", // use real FQDN with rDNS
  mailFrom:
    process.env.MAIL_FROM ||
    `postmaster@${(process.env.HELO_HOST || "verifier.local")
      .toString()
      .replace(/^.+?\./, "")}`,
  connectionTimeoutMs: Number(process.env.SMTP_CONNECT_TIMEOUT_MS || 10000),
  commandTimeoutMs: Number(process.env.SMTP_COMMAND_TIMEOUT_MS || 15000),
  smtpPort: Number(process.env.SMTP_PORT || 25),
  tryStartTLS:
    String(process.env.SMTP_TRY_STARTTLS || "true").toLowerCase() === "true",
  catchAllProbe:
    String(process.env.SMTP_CATCHALL_PROBE || "true").toLowerCase() === "true",
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

const DISPOSABLE = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "yopmail.com",
  "tempmailo.com",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomLocal() {
  return `validator_${randomBytes(6).toString("hex")}`;
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) =>
    (t = setTimeout(() => rej(new Error(`${label}-timeout`)), ms))
  );
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Read a complete SMTP multiline reply: e.g. "250-..." ... "250 <space> final"
function readReply(stream, label) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1] || "";
      const m = last.match(/^(\d{3})([ -])/);
      if (!m) return; // keep reading
      const code = Number(m[1]);
      const sep = m[2];
      if (sep === " ") {
        cleanup();
        resolve({ code, message: lines.join("\n") });
      }
    };
    const onError = (e) => {
      cleanup();
      reject(new Error(`${label || "smtp"}: ${e.message}`));
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`${label || "smtp"}: connection ended`));
    };
    const cleanup = () => {
      stream.off("data", onData);
      stream.off("error", onError);
      stream.off("end", onEnd);
    };
    stream.on("data", onData);
    stream.once("error", onError);
    stream.once("end", onEnd);
  });
}

// ---------------------------------------------------------------------------
// 1) Normalize
// ---------------------------------------------------------------------------
export function normalizeEmail(raw) {
  const trimmed = String(raw || "").trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1)
    return { ok: false, reason: "missing-at" };

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);

  let asciiDomain;
  try {
    asciiDomain = domain.split(".").map(toASCII).join(".");
  } catch {
    return { ok: false, reason: "bad-idn" };
  }

  return {
    ok: true,
    local,
    domain: asciiDomain.toLowerCase(), // domain case-insensitive
    address: `${local}@${asciiDomain.toLowerCase()}`,
  };
}

// ---------------------------------------------------------------------------
// 2) Syntax checks
// ---------------------------------------------------------------------------
export function basicSyntaxCheck(local, domain) {
  const total = `${local}@${domain}`;
  if (total.length > 254) return { ok: false, reason: "too-long" };
  if (local.length === 0 || local.length > 64)
    return { ok: false, reason: "bad-local-length" };
  if (domain.length === 0) return { ok: false, reason: "empty-domain" };
  if (domain.split(".").some((lbl) => lbl.length === 0 || lbl.length > 63))
    return { ok: false, reason: "bad-domain-label" };

  const dotAtom =
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  const quoted = /^"([\s\S]|\\")+"$/;
  if (!(dotAtom.test(local) || quoted.test(local)))
    return { ok: false, reason: "bad-local-syntax" };

  const domainRe = /^(?=.{1,253}$)([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
  if (!domainRe.test(domain)) return { ok: false, reason: "bad-domain-syntax" };

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3) DNS (MX → fallback A/AAAA)
// ---------------------------------------------------------------------------
export async function resolveMailHosts(domain) {
  try {
    const mx = await dns.resolveMx(domain);
    if (mx?.length) {
      // Sort by priority; randomize within equal priority groups
      const byPri = new Map();
      for (const r of mx) {
        if (!byPri.has(r.priority)) byPri.set(r.priority, []);
        byPri.get(r.priority).push(r.exchange);
      }
      const ordered = Array.from(byPri.keys())
        .sort((a, b) => a - b)
        .flatMap((p) => {
          const g = byPri.get(p);
          for (let i = g.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [g[i], g[j]] = [g[j], g[i]];
          }
          return g;
        });
      return ordered;
    }
  } catch {}
  // RFC fallback: try A/AAAA, though many hosts refuse
  const hosts = new Set();
  try {
    (await dns.resolve4(domain)).forEach(() => hosts.add(domain));
  } catch {}
  try {
    (await dns.resolve6(domain)).forEach(() => hosts.add(domain));
  } catch {}
  return Array.from(hosts);
}

// ---------------------------------------------------------------------------
// 4) SMTP callout with EHLO/STARTTLS and multiline reply parsing
// ---------------------------------------------------------------------------
async function smtpCheckAddress(host, email, opts) {
  const base = { host, code: null, stage: null, message: null };

  return withTimeout(
    new Promise(async (resolve) => {
      const socket = net.createConnection({ host, port: opts.smtpPort });
      const finish = (payload) => {
        try {
          socket.end();
          socket.destroy();
        } catch {}
        resolve({ ...base, ...payload });
      };

      socket.setTimeout(opts.connectionTimeoutMs);
      socket.once("timeout", () =>
        finish({ stage: "connect", message: "connection timeout" })
      );
      socket.once("error", (e) =>
        finish({ stage: "connect", message: e.message })
      );

      try {
        // 220 greeting
        let r = await readReply(socket, "greeting");
        if (r.code !== 220)
          return finish({ stage: "greeting", code: r.code, message: r.message });

        // EHLO
        socket.write(`EHLO ${opts.heloHost}\r\n`);
        r = await readReply(socket, "EHLO");
        if (r.code !== 250) {
          socket.write(`HELO ${opts.heloHost}\r\n`);
          r = await readReply(socket, "HELO");
          if (r.code !== 250)
            return finish({ stage: "HELO", code: r.code, message: r.message });
        }

        // STARTTLS if advertised
        if (opts.tryStartTLS && /STARTTLS/i.test(r.message)) {
          socket.write("STARTTLS\r\n");
          const start = await readReply(socket, "STARTTLS");
          if (start.code === 220) {
            const tlsSocket = tls.connect({
              socket,
              servername: host,
              rejectUnauthorized: false, // many MX don't present valid chains
            });
            // EHLO again over TLS
            tlsSocket.write(`EHLO ${opts.heloHost}\r\n`);
            r = await readReply(tlsSocket, "EHLO(TLS)");
            if (r.code !== 250)
              return finish({
                stage: "EHLO(TLS)",
                code: r.code,
                message: r.message,
              });

            // MAIL FROM / RCPT TO
            tlsSocket.write(`MAIL FROM:<${opts.mailFrom}>\r\n`);
            r = await readReply(tlsSocket, "MAIL FROM");
            if (r.code !== 250)
              return finish({ stage: "MAIL FROM", code: r.code, message: r.message });

            tlsSocket.write(`RCPT TO:<${email}>\r\n`);
            r = await readReply(tlsSocket, "RCPT TO");
            tlsSocket.write("QUIT\r\n");
            return finish({ stage: "RCPT TO", code: r.code, message: r.message });
          }
          // If STARTTLS refused, continue plain
        }

        // Plain path
        socket.write(`MAIL FROM:<${opts.mailFrom}>\r\n`);
        r = await readReply(socket, "MAIL FROM");
        if (r.code !== 250)
          return finish({ stage: "MAIL FROM", code: r.code, message: r.message });

        socket.write(`RCPT TO:<${email}>\r\n`);
        r = await readReply(socket, "RCPT TO");
        socket.write("QUIT\r\n");
        return finish({ stage: "RCPT TO", code: r.code, message: r.message });
      } catch (e) {
        return finish({ stage: "error", message: e.message });
      }
    }),
    DEFAULT_OPTS.commandTimeoutMs,
    "smtp"
  );
}

// Race a couple of MX hosts in parallel; return first 250 or last result
async function smtpCheckAnyHost(hosts, email, opts, maxParallel = 2) {
  const q = hosts.slice();
  const results = [];
  let winner = null;

  async function worker() {
    while (!winner && q.length) {
      const host = q.shift();
      try {
        const r = await smtpCheckAddress(host, email, opts);
        results.push(r);
        if (r.code === 250) winner = r;
      } catch (_) {
        // swallow
      }
    }
  }

  const n = Math.min(maxParallel, hosts.length);
  await Promise.all(Array.from({ length: n }, worker));
  return winner || results[results.length - 1] || { code: null, message: "" };
}

async function checkCatchAll(host, domain, opts) {
  const probe = `${randomLocal()}@${domain}`;
  const r = await smtpCheckAddress(host, probe, opts);
  return r.code === 250; // strong indicator, not 100%
}

export function isDisposable(domain) {
  return DISPOSABLE.has(domain);
}

// ---------------------------------------------------------------------------
// 6) Public API
// ---------------------------------------------------------------------------
export async function verifyEmail(rawEmail, userOpts = {}) {
  const opts = { ...DEFAULT_OPTS, ...userOpts };
  const normalized = normalizeEmail(rawEmail);
  if (!normalized.ok) {
    return { input: rawEmail, result: "undeliverable", reason: normalized.reason };
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

  const tried = [];
  let accepted = false;
  let finalCode = null;
  let finalMsg = null;
  let catchAll = null;

  const r = await smtpCheckAnyHost(hosts, address, opts, 2);
  tried.push(r);
  finalCode = r.code;
  finalMsg = r.message;
  if (r.code === 250) {
    accepted = true;
    if (opts.catchAllProbe) {
      try {
        catchAll = await checkCatchAll(r.host, domain, opts);
      } catch {
        catchAll = null;
      }
    }
  }

  if (accepted) {
    return {
      input: rawEmail,
      normalized: address,
      result: catchAll ? "risky" : "deliverable",
      reason: catchAll ? "catch-all-domain" : "accepted",
      smtp: tried,
      roleAccount: role,
      disposableDomain: disposable,
      catchAll,
    };
  }

  if ([450, 451, 452, 421].includes(finalCode) || /timeout/i.test(finalMsg || "")) {
    return {
      input: rawEmail,
      normalized: address,
      result: "risky",
      reason: `temporary-failure:${finalCode || "timeout"}`,
      smtp: tried,
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
    smtp: tried,
    roleAccount: role,
    disposableDomain: disposable,
    catchAll,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMainModule =
  process.argv[1] &&
  (process.argv[1] === new URL(import.meta.url).pathname ||
    process.argv[1].endsWith("emailVerifier.js"));

if (isMainModule) {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: node utils/emailVerifier.js someone@example.com");
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
