import dotenv from "dotenv";
dotenv.config();
import { verifyEmail } from "./utils/emailVerifier.js";
import { scrapeEmails } from "./utils/emailScraper.js";
import { performance } from "perf_hooks";

function getCoordsFromUrl(u) {
  // matches ...!3d24.379259!4d91.4136279...
  const m = u.match(/!3d(-?\d+(\.\d+)?)!4d(-?\d+(\.\d+)?)/);
  return m
    ? { latitude: parseFloat(m[1]), longitude: parseFloat(m[3]) }
    : { latitude: null, longitude: null };
}

export async function extractBusinessDetails(
  page,
  browser,
  searchTerm,
  searchLocation,
  ratingFilter = null,
  reviewFilter = null,
  isExtractEmail = false,
  isValidate = false
) {
  // const T_OVERALL_START = performance.now();

  // --- NEW: wait for the header & rating cluster to render (don’t hard-fail if rating is missing) ---
  try {
    await page.waitForSelector("h1.DUwDvf.lfPIob", {
      visible: true,
      timeout: 7000,
    });
  } catch (_) {} // some places have slow paint; we’ll still attempt evaluate

  try {
    await page.waitForSelector('.F7nice .ceNzKf[role="img"]', {
      visible: true,
      timeout: 7000,
    });
  } catch (_) {}

  try {
    await page.waitForSelector(
      'a[data-item-id="authority"], a[aria-label^="Website"], a[aria-label="Open website"], button[aria-label*="Website"]',
      { visible: true, timeout: 7000 }
    );
  } catch (_) {}

  // --- NEW: parse coords from page.url() (reliable) ---
  const { latitude, longitude } = getCoordsFromUrl(page.url());

  let businessData;
  try {
    businessData = await Promise.race([
      page.evaluate(
        (searchTerm, searchLocation, ratingFilter, reviewFilter) => {
          const qs = (sel) => document.querySelector(sel);
          const txt = (el) => el?.textContent?.trim() || null;

          const normalizeWebsiteHref = (href) => {
            if (!href) return null;
            try {
              const u = new URL(href, location.href);
              // Google redirector used by Maps sometimes
              if (u.hostname.includes("google.") && u.pathname === "/url") {
                const q = u.searchParams.get("q");
                return q || u.href;
              }
              return u.href;
            } catch {
              return href;
            }
          };

          // Name (place header)
          const name = txt(qs("h1.DUwDvf.lfPIob"));

          // Category: specifically the category button near the title
          const category = txt(qs('button[jsaction="pane.wfvdle18.category"]'));

          // Rating value from aria-label of the stars beside the rating
          const ratingEl = qs('.F7nice .ceNzKf[role="img"]');
          const ratingLabel = ratingEl?.getAttribute("aria-label") || "";
          const ratingMatch = ratingLabel.match(/(\d+(?:\.\d+)?)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : null;

          // Review count (the little “(123)” with aria-label “123 reviews” or “1 review”)
          const reviewBadge = qs(
            '.F7nice [aria-label$="reviews"], .F7nice [aria-label$="review"]'
          );
          const reviewCountLabel =
            reviewBadge?.getAttribute("aria-label") || "";
          const reviewCountMatch = reviewCountLabel.match(/(\d+)\s+reviews?$/i);
          const reviewCount = reviewCountMatch
            ? parseInt(reviewCountMatch[1], 10)
            : 0;

          // Optional filters (applied on parsed values)
          if (ratingFilter && typeof rating === "number") {
            const { operator, value } = ratingFilter;
            const bad =
              (operator === "gt" && !(rating > value)) ||
              (operator === "gte" && !(rating >= value)) ||
              (operator === "lt" && !(rating < value)) ||
              (operator === "lte" && !(rating <= value));
            if (bad) return null;
          }
          if (reviewFilter) {
            const { operator, value } = reviewFilter;
            const c = reviewCount;
            const bad =
              (operator === "gt" && !(c > value)) ||
              (operator === "gte" && !(c >= value)) ||
              (operator === "lt" && !(c < value)) ||
              (operator === "lte" && !(c <= value));
            if (bad) return null;
          }

          // Phone (works)
          const phoneHref = qs(
            'a[aria-label="Call phone number"]'
          )?.getAttribute("href");
          const phone = phoneHref ? phoneHref.replace("tel:", "") : null;

          // Address (works)
          const addressBtn = qs('button[aria-label^="Address:"]');
          const address = addressBtn
            ? addressBtn
                .getAttribute("aria-label")
                .replace(/^Address:\s*/, "")
                .trim()
            : null;

          let website = null;

          // 1) Primary: explicit Website row
          const authorityLink = qs('a[data-item-id="authority"]');
          if (authorityLink) {
            website = normalizeWebsiteHref(authorityLink.getAttribute("href"));
          }

          // 2) Common aria/data-tooltip variants
          if (!website) {
            const a = qs(
              'a[aria-label^="Website"], a[aria-label*="Website"], a[data-tooltip="Open website"]'
            );
            website = normalizeWebsiteHref(a?.getAttribute("href"));
          }

          // 3) Fallback: some places only expose an "action" link (booking/menu) that is the site
          if (!website) {
            const actionCandidates = [
              ...document.querySelectorAll('a[data-item-id^="action:"]'),
            ];
            const action = actionCandidates.find((a) => {
              const href = a.getAttribute("href") || "";
              const label = (
                a.getAttribute("aria-label") ||
                a.textContent ||
                ""
              ).trim();
              // pick http(s) links that look like a site (avoid tel:, mailto:, maps links)
              return (
                /^https?:\/\//i.test(href) &&
                !/google\.[^/]+\/maps/i.test(href) &&
                /\.[a-z]{2,}/i.test(label || href)
              ); // has a domain-ish TLD
            });
            if (action) {
              website = normalizeWebsiteHref(action.getAttribute("href"));
            }
          }

          // 4) Last-ditch: sometimes owner posts include the site (not 100% reliable)
          if (!website) {
            const ownerPostLink = document.querySelector(
              '[data-section-id="345"] [data-link^="http"]'
            ); // "From the owner"
            if (ownerPostLink)
              website = normalizeWebsiteHref(
                ownerPostLink.getAttribute("data-link")
              );
          }

          return {
            name,
            phone,
            website,
            email: null,
            email_status: null,
            address,
            // coords set outside (more reliable), we’ll fill them after evaluate
            latitude: null,
            longitude: null,
            rating: typeof rating === "number" ? rating : null,
            rating_count: String(reviewCount),
            category: category || null,
            search_term: searchTerm,
            search_type: "Google Maps",
            search_location: searchLocation,
          };
        },
        searchTerm,
        searchLocation,
        ratingFilter,
        reviewFilter
      ),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Business data extraction timed out")),
          10000
        )
      ),
    ]);

    if (!businessData) return null;

    // inject reliable coords parsed from the URL
    businessData.latitude = latitude;
    businessData.longitude = longitude;

    // Initialize timings bucket
    // businessData.timings = {
    //   scrape_ms: null,
    //   verify: { wall_ms: null, sum_email_ms: null, per_email: [] },
    //   total_ms: null,
    // };

    if (
      isExtractEmail &&
      businessData.website &&
      !businessData.website.startsWith("javascript:")
    ) {
      try {
        // const T_SCRAPE_START = performance.now();
        const { emails: rawEmails } = await scrapeEmails({
          browser,
          startUrl: businessData.website,
          options: {
            depth: 1,
            max: 6,
            timeout: 8000,
            delay: 300,
            wait: "dom",
            budget: 10000,
            perPageLinks: 12,
            firstOnly: false,
            restrictDomain: false, // allow gmail/outlook etc.
            noDeobfuscate: true,
          },
        });
        // businessData.timings.scrape_ms = Math.round(
        //   performance.now() - T_SCRAPE_START
        // );

        // Normalize + dedupe (case-insensitive)
        const seen = new Set();
        const uniqueEmails = [];
        for (const e of rawEmails) {
          const k = String(e || "")
            .trim()
            .toLowerCase();
          if (k && !seen.has(k)) {
            seen.add(k);
            uniqueEmails.push(k);
          }
        }

        // Prefer site-domain emails first (improves yield & speed)
        const siteHost = (() => {
          try {
            return new URL(businessData.website).hostname
              .replace(/^www\./, "")
              .toLowerCase();
          } catch {
            return null;
          }
        })();
        if (siteHost) {
          uniqueEmails.sort((a, b) => {
            const da = a.split("@")[1]?.toLowerCase() || "";
            const db = b.split("@")[1]?.toLowerCase() || "";
            return (
              (db.endsWith(siteHost) ? 1 : 0) - (da.endsWith(siteHost) ? 1 : 0)
            );
          });
        }

        // Verify emails only if isValidate is true
        if (isValidate) {
          const verifyOpts = {
            heloHost: process.env.HELO_HOST,
            mailFrom: process.env.MAIL_FROM,
            connectionTimeoutMs: Number(
              process.env.SMTP_CONNECT_TIMEOUT_MS || 10000
            ),
            commandTimeoutMs: Number(
              process.env.SMTP_COMMAND_TIMEOUT_MS || 15000
            ),
          };

          const concurrency = 3;
          const q = [...uniqueEmails];
          const results = [];

          // const T_VERIFY_WALL_START = performance.now();
          async function worker() {
            while (q.length) {
              const email = q.shift();
              // const t0 = performance.now();
              try {
                const res = await verifyEmail(email, verifyOpts);
                // const ms = Math.round(performance.now() - t0);
                results.push({
                  email,
                  result: res?.result || "unknown",
                  reason: res?.reason || "no reason provided",
                  code: res?.smtp?.[0]?.code || null,
                  // ms,
                });
              } catch (err) {
                // const ms = Math.round(performance.now() - t0);
                results.push({
                  email,
                  result: "error",
                  reason: err?.message || "verification error",
                  code: null,
                  // ms,
                });
              }
            }
          }

          await Promise.all(
            Array.from({ length: Math.min(concurrency, q.length) }, worker)
          );

          // const verifyWallMs = Math.round(
          //   performance.now() - T_VERIFY_WALL_START
          // );
          // const verifySumMs = results.reduce((acc, r) => acc + (r.ms || 0), 0);

          // Check if SMTP is likely blocked for fallback logic
          const FALLBACK_ON_SMTP_FAILURE =
            String(
              process.env.EMAIL_FALLBACK_ON_SMTP_FAILURE || "false"
            ).toLowerCase() === "true";

          const smtpLikelyBlocked =
            uniqueEmails.length > 0 &&
            results.length === uniqueEmails.length &&
            results.every(
              (r) =>
                r.result === "error" ||
                (r.result !== "deliverable" &&
                  /timeout|connect|refused|unreachable|temporary-failure/i.test(
                    r.reason || ""
                  ))
            );

          if (smtpLikelyBlocked && FALLBACK_ON_SMTP_FAILURE) {
            // SMTP blocked - return empty arrays
            businessData.email = [];
            businessData.email_status = [];
            businessData.email_verification = {
              mode: "fallback",
              details: results,
            };
          } else {
            // Store all emails and their statuses
            businessData.email = uniqueEmails;
            // Create status array that corresponds to email array by index
            businessData.email_status = uniqueEmails.map((email) => {
              const result = results.find((r) => r.email === email);
              return result ? result.result : "unknown";
            });
            businessData.email_verification = {
              mode: "verified",
              details: results,
            };
          }
        } else {
          // Email extraction but no validation - return all unique emails as unverified
          businessData.email = uniqueEmails;
          businessData.email_status = uniqueEmails.map(() => "unverified");
          businessData.email_verification = {
            mode: "unverified",
            details: [],
          };
        }

        // attach verification timing summary
        // businessData.timings.verify = {
        //   wall_ms: verifyWallMs,
        //   sum_email_ms: verifySumMs,
        //   per_email: results.map(({ email, ms, result, reason, code }) => ({
        //     email,
        //     ms,
        //     result,
        //     reason,
        //     code,
        //   })),
        // };
      } catch (err) {
        console.warn(
          "email extraction/verification failed:",
          err?.message || err
        );
        businessData.email = [];
        businessData.email_status = [];
      }
    } else {
      businessData.email = [];
      businessData.email_status = [];
    }
  } catch (_) {
    return null;
  }

  // total time for this extractor run
  // businessData.timings = businessData.timings || {
  //   scrape_ms: null,
  //   verify: { wall_ms: null, sum_email_ms: null, per_email: [] },
  //   total_ms: null,
  // };
  // businessData.timings.total_ms = Math.round(
  //   performance.now() - T_OVERALL_START
  // );

  return businessData;
}
