import dotenv from "dotenv";
dotenv.config();
import { verifyEmail } from "./utils/emailVerifier.js";
import { scrapeEmails } from "./utils/emailScraper.js";

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
  isExtractEmail = false
) {
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

    // --- Email extraction via reusable scraper + verification ---
    if (
      isExtractEmail &&
      businessData.website &&
      !businessData.website.startsWith("javascript:")
    ) {
      try {
        // 1) Collect candidate emails from the website
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
            restrictDomain: false, // allow Gmail/Outlook etc.
            noDeobfuscate: true, // exact email patterns + mailto + cfemail
          },
        });

        // Normalize/dedupe early
        const uniqueEmails = Array.from(
          new Set(rawEmails.map((e) => String(e).trim()))
        );

        console.log("rawEmails:", uniqueEmails);

        // 2) Verify (accept deliverable OR risky by default)
        const verifyOpts = {
          heloHost: process.env.HELO_HOST,
          mailFrom: process.env.MAIL_FROM,
          connectionTimeoutMs: 20000,
          commandTimeoutMs: 20000,
        };

        const ACCEPT_POLICY = "deliverable";

        const concurrency = 3;
        const q = [...uniqueEmails];
        const accepted = [];
        const results = []; // for debug/diagnostics

        const acceptByPolicy = (res) => {
          if (!res) return false;
          return res.result === "deliverable";
        };

        async function worker() {
          while (q.length) {
            const email = q.shift();
            try {
              const res = await verifyEmail(email, verifyOpts);
              results.push({ email, result: res?.result, reason: res?.reason });
              if (acceptByPolicy(res)) accepted.push(email);
            } catch (err) {
              results.push({
                email,
                result: "error",
                reason: err?.message || "error",
              });
            }
          }
        }

        await Promise.all(
          Array.from({ length: Math.min(concurrency, q.length) }, worker)
        );

        // 3) Optional fallback when SMTP is clearly unreachable (egress blocked)
        const FALLBACK_ON_SMTP_FAILURE =
          String(
            process.env.EMAIL_FALLBACK_ON_SMTP_FAILURE || "true"
          ).toLowerCase() === "true";

        const smtpLikelyBlocked =
          accepted.length === 0 &&
          uniqueEmails.length > 0 &&
          results.length === uniqueEmails.length &&
          results.every(
            (r) =>
              r.result === "error" ||
              (r.result === "undeliverable" &&
                /timeout|connect|refused|unreachable/i.test(r.reason || ""))
          );

        if (
          accepted.length === 0 &&
          smtpLikelyBlocked &&
          FALLBACK_ON_SMTP_FAILURE
        ) {
          // When SMTP is blocked, don't include any emails since we can't verify them
          // businessData.emails = [];
          businessData.email = [];
          businessData.email_verification = {
            mode: "fallback",
            details: results,
          };
        } else {
          // businessData.emails = accepted;
          businessData.email = accepted || null;
          businessData.email_verification = {
            mode: ACCEPT_POLICY,
            details: results,
          };
        }
      } catch (err) {
        console.warn(
          "email extraction/verification failed:",
          err?.message || err
        );
        // businessData.emails = [];
        businessData.email = [];
      }
    } else {
      // businessData.emails = [];
      businessData.email = [];
    }
  } catch (_) {
    return null;
  }

  return businessData;
}
