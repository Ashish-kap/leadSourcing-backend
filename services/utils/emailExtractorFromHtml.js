

import * as cheerio from 'cheerio';
import logger from '../logger.js';

const EMAIL_RE = /(?:^|[\s,;()"'<>])([a-zA-Z0-9][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}\.[a-zA-Z]{2,})(?=[\s,;()"'<>]|$)/g;

/**
 * @param {string} email - Email to validate
 * @returns {boolean} True if email is valid
 */
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  
  const [localPart, domain] = email.split('@');
  if (!localPart || !domain) return false;
  
  const letterCount = (localPart.match(/[a-zA-Z]/g) || []).length;
  if (letterCount < 2) return false;
  
  const digitCount = (localPart.match(/\d/g) || []).length;
  if (digitCount > localPart.length * 0.5) return false;
  
  if (/^\d{3,4}-?\d{4}/.test(localPart)) return false;
  
  if (/^\d{5}/.test(localPart)) return false;
  
  if (/[\s()<>"]/.test(email)) return false;
  
  
  if (!/^[a-zA-Z0-9.-]+$/.test(domain)) return false;
  
  const domainPattern = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,6}$/;
  if (!domainPattern.test(domain)) return false;
  
  const domainParts = domain.split('.');
  if (domainParts.length < 2) return false;
  
  const tld = domainParts[domainParts.length - 1];
  if (!/^[a-zA-Z]{2,6}$/.test(tld)) return false;
  
  if (!domain.endsWith('.' + tld)) return false;
  
  if (tld.length >= 5) {
    const commonLongTlds = ['email', 'online', 'website', 'global', 'travel', 'museum', 'coffee', 'photos', 'videos'];
    if (!commonLongTlds.includes(tld.toLowerCase())) {
      const commonShortTlds = ['com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'co', 'io', 'ai', 'uk', 'us', 'ca', 'au', 'de', 'fr', 'jp', 'cn'];
      const tldLower = tld.toLowerCase();
      for (const shortTld of commonShortTlds) {
        if (tldLower.startsWith(shortTld) && tldLower.length > shortTld.length + 2) {
          return false;
        }
      }
    }
  }
  
  return true;
}

/**
 * Extract emails from HTML content
 * @param {string} html - HTML content
 * @param {string} websiteUrl - Base URL for context
 * @returns {string[]} Array of unique emails
 */
export function extractEmailsFromHtml(html, websiteUrl) {
  if (!html || typeof html !== 'string') {
    return [];
  }
  
  try {
    const $ = cheerio.load(html);
    const emails = new Set();
    
    // 1. Extract from mailto: links (always valid, but validate anyway)
    $('a[href^="mailto:"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const email = href.replace(/^mailto:/i, '').split('?')[0].trim();
      if (email && isValidEmail(email)) {
        emails.add(email.toLowerCase());
      }
    });
    
    // 1.5. Extract from anchor tag text content (even if not mailto)
    $('a').each((_, el) => {
      // Check text content
      const anchorText = $(el).text().trim();
      if (anchorText) {
        const textMatches = [...anchorText.matchAll(EMAIL_RE)];
        textMatches.forEach(match => {
          const email = match[1];
          if (email) {
            if (isValidEmail(email)) {
              emails.add(email.toLowerCase());
            } else if (process.env.LOG_EMAIL_FAILURES === "true") {
              logger.debug('EMAIL_REJECTED_ANCHOR_TEXT', `Email rejected from anchor text: ${email}`, {
                email,
                anchorText: anchorText.substring(0, 100),
                websiteUrl
              });
            }
          }
        });
      }
      
      // Check href attribute (even if not mailto:)
      const href = $(el).attr('href') || '';
      if (href && !href.startsWith('mailto:') && !href.startsWith('http')) {
        const hrefMatches = [...href.matchAll(EMAIL_RE)];
        hrefMatches.forEach(match => {
          const email = match[1];
          if (email) {
            if (isValidEmail(email)) {
              emails.add(email.toLowerCase());
            } else if (process.env.LOG_EMAIL_FAILURES === "true") {
              logger.debug('EMAIL_REJECTED_ANCHOR_HREF', `Email rejected from anchor href: ${email}`, {
                email,
                href: href.substring(0, 100),
                websiteUrl
              });
            }
          }
        });
      }
    });
    
    // 2. Extract from visible text (two-pass: strict first, then relaxed fallback)
    const bodyText = $('body').text() || '';
    const RELAXED_EMAIL_RE = /([a-zA-Z0-9][a-zA-Z0-9._%+-]{0,63}@[a-zA-Z0-9][a-zA-Z0-9.-]{0,254}\.[a-zA-Z]{2,})(?=[\s,;()"'<>]|$)/g;
    
    // Pass 1: Use strict regex (avoids false positives)
    const textMatches = [...bodyText.matchAll(EMAIL_RE)];
    textMatches.forEach(match => {
      const email = match[1]; // Extract capture group 1
      if (email) {
        if (isValidEmail(email)) {
          emails.add(email.toLowerCase());
        } else if (process.env.LOG_EMAIL_FAILURES === "true") {
          logger.debug('EMAIL_REJECTED_BODY_TEXT', `Email rejected from body text: ${email}`, {
            email,
            websiteUrl
          });
        }
      }
    });
    
    // Pass 2: Use relaxed regex for emails that might be after emojis/special characters
    // Only process if we haven't found many emails yet (performance optimization)
    if (emails.size < 5) {
      const relaxedMatches = [...bodyText.matchAll(RELAXED_EMAIL_RE)];
      relaxedMatches.forEach(match => {
        const email = match[1];
        if (email && isValidEmail(email)) {
          // Only add if not already found (Set handles deduplication, but this avoids unnecessary validation)
          if (!emails.has(email.toLowerCase())) {
            emails.add(email.toLowerCase());
          }
        }
      });
    }
    
    // 3. Extract from Cloudflare protected emails
    $('[data-cfemail]').each((_, el) => {
      const hex = $(el).attr('data-cfemail');
      if (hex) {
        const decoded = decodeCfEmail(hex);
        if (decoded && isValidEmail(decoded)) {
          emails.add(decoded.toLowerCase());
        }
      }
    });
    
    // 4. Extract from meta tags
    $('meta[name*="email"], meta[property*="email"], meta[name="contact"], meta[property="contact"]').each((_, el) => {
      const content = $(el).attr('content') || '';
      const matches = [...content.matchAll(EMAIL_RE)];
      matches.forEach(match => {
        const email = match[1]; // Extract capture group 1
        if (email && isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
    });
    
    // 5. Extract from footer
    const footerText = $('footer, .footer, #footer').text() || '';
    const footerMatches = [...footerText.matchAll(EMAIL_RE)];
    footerMatches.forEach(match => {
      const email = match[1]; // Extract capture group 1
      if (email && isValidEmail(email)) {
        emails.add(email.toLowerCase());
      }
    });
    
    // 6. Extract from data attributes
    $('[data-email], [data-contact]').each((_, el) => {
      const dataEmail = $(el).attr('data-email');
      const dataContact = $(el).attr('data-contact');
      [dataEmail, dataContact].forEach(str => {
        if (str) {
          const matches = [...str.matchAll(EMAIL_RE)];
          matches.forEach(match => {
            const email = match[1]; // Extract capture group 1
            if (email && isValidEmail(email)) {
              emails.add(email.toLowerCase());
            }
          });
        }
      });
    });
    
    // 7. Extract from aria-labels
    $('[aria-label*="email"], [aria-label*="Email"], [aria-label*="contact"], [aria-label*="Contact"]').each((_, el) => {
      const ariaLabel = $(el).attr('aria-label') || '';
      const matches = [...ariaLabel.matchAll(EMAIL_RE)];
      matches.forEach(match => {
        const email = match[1]; // Extract capture group 1
        if (email && isValidEmail(email)) {
          emails.add(email.toLowerCase());
        }
      });
    });
    
    // 8. Extract from JSON-LD structured data
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const scriptContent = $(el).html() || $(el).text() || '{}';
        const data = JSON.parse(scriptContent);
        extractEmailsFromJsonLd(data, emails);
      } catch (err) {
        // Ignore JSON parse errors
      }
    });
    
    // Filter and sanitize
    const sanitized = sanitizeEmails(Array.from(emails));
    
    logger.info('EMAIL_EXTRACTOR_HTML', `Extracted ${sanitized.length} emails from HTML`);
    
    return sanitized;
  } catch (error) {
    logger.error('EMAIL_EXTRACTOR_HTML_ERROR', `Error extracting emails from HTML: ${error.message}`);
    return [];
  }
}

/**
 * Decode Cloudflare protected email
 */
function decodeCfEmail(hex) {
  try {
    const r = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ r);
    }
    return out.includes('@') ? out : null;
  } catch {
    return null;
  }
}

/**
 * Recursively extract emails from JSON-LD structured data
 */
function extractEmailsFromJsonLd(obj, emails) {
  if (!obj || typeof obj !== 'object') return;
  
  if (obj.email && typeof obj.email === 'string' && isValidEmail(obj.email)) {
    emails.add(obj.email.toLowerCase());
  }
  
  if (obj.contactPoint && obj.contactPoint.email && isValidEmail(obj.contactPoint.email)) {
    emails.add(obj.contactPoint.email.toLowerCase());
  }
  
  Object.values(obj).forEach(val => {
    if (Array.isArray(val)) {
      val.forEach(item => extractEmailsFromJsonLd(item, emails));
    } else if (typeof val === 'object' && val !== null) {
      extractEmailsFromJsonLd(val, emails);
    }
  });
}

/**
 * Sanitize and filter emails
 */
function sanitizeEmails(emails) {
  const badTlds = new Set([
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico',
    'css', 'js', 'mjs', 'cjs', 'map', 'json',
    'ttf', 'eot', 'woff', 'woff2',
    'pdf', 'zip', 'rar', '7z', 'exe', 'dmg',
    'mp4', 'mp3', 'avi', 'mov', 'webm'
  ]);
  
  return emails
    .filter(email => {
      if (!email || typeof email !== 'string') return false;
      
      // Remove mailto: prefix if present
      const cleanEmail = email.replace(/^mailto:/i, '').trim();
      if (!cleanEmail) return false;
      
      // Basic email validation
      const [local, domain] = cleanEmail.split('@');
      if (!local || !domain) return false;
      
      // Check for bad TLDs
      const tld = domain.toLowerCase().split('.').pop();
      if (!tld || badTlds.has(tld)) return false;
      
      // Filter out invalid characters
      if (/[\\/]/.test(cleanEmail)) return false;
      
      return true;
    })
    .map(email => email.replace(/^mailto:/i, '').trim().toLowerCase())
    .filter((email, index, self) => self.indexOf(email) === index) // Dedupe
    .slice(0, 50); // Limit to 50 emails
}

/**
 * Find priority page URLs from HTML (contact, about, team, impressum)
 * @param {string} html - HTML content
 * @param {string} baseUrl - Base URL for resolving relative links
 * @returns {string[]} Array of priority page URLs sorted by importance
 */
export function findContactUrls(html, baseUrl) {
  if (!html || typeof html !== 'string' || !baseUrl) {
    return [];
  }
  
  try {
    const $ = cheerio.load(html);
    const priorityUrls = new Map(); // Use Map to store URL with score
    
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().toLowerCase().trim();
      const hrefLower = href.toLowerCase();
      
      // Calculate priority score based on keywords
      let score = 0;
      
      // Contact pages (highest priority)
      if (hrefLower.includes('contact') || text.includes('contact')) score += 100;
      if (hrefLower.includes('reach') || text.includes('reach')) score += 90;
      if (hrefLower.includes('get-in-touch') || text.includes('get in touch')) score += 90;
      
      // About pages (high priority)
      if (hrefLower.includes('about') || text.includes('about')) score += 70;
      if (hrefLower.includes('about-us') || text.includes('about us')) score += 75;
      if (hrefLower.includes('company') || text.includes('company')) score += 60;
      
      // Team pages (medium priority)
      if (hrefLower.includes('team') || text.includes('team')) score += 50;
      if (hrefLower.includes('our-team') || text.includes('our team')) score += 55;
      if (hrefLower.includes('staff') || text.includes('staff')) score += 50;
      
      // Impressum (EU legal requirement - medium priority)
      if (hrefLower.includes('impressum') || text.includes('impressum')) score += 60;
      
      // Connect/support pages (lower priority)
      if (hrefLower.includes('connect') || text.includes('connect')) score += 40;
      if (hrefLower.includes('support') || text.includes('support')) score += 35;
      
      // Only process URLs with positive scores
      if (score > 0) {
        try {
          const url = new URL(href, baseUrl).toString();
          
          // Only include HTTP/HTTPS URLs
          if (url.startsWith('http://') || url.startsWith('https://')) {
            // Exclude common non-priority pages
            if (!url.match(/\.(jpg|jpeg|png|gif|svg|pdf|zip|css|js)(\?|$)/i)) {
              // Exclude common non-relevant paths
              if (!url.match(/\/(blog|news|products|services|portfolio|gallery)\//i)) {
                // Keep highest score if URL already exists
                const existingScore = priorityUrls.get(url) || 0;
                if (score > existingScore) {
                  priorityUrls.set(url, score);
                }
              }
            }
          }
        } catch (err) {
          // Invalid URL, skip
        }
      }
    });
    
    // Convert to array and sort by score (highest first)
    const urls = Array.from(priorityUrls.entries())
      .sort((a, b) => b[1] - a[1])
      .map(entry => entry[0]);
    
    // Remove duplicate base domain (if homepage is in the list, remove it)
    const filtered = urls.filter(url => {
      try {
        const urlObj = new URL(url);
        const baseUrlObj = new URL(baseUrl);
        // Keep if it's not just the base domain
        return urlObj.pathname !== '/' && urlObj.pathname !== baseUrlObj.pathname;
      } catch {
        return true;
      }
    });
    
    logger.info('PRIORITY_URLS_FOUND', `Found ${filtered.length} priority URLs from ${baseUrl}`);
    
    // Return top 7 priority pages (contact, about, team, etc.)
    return filtered.slice(0, 7);
  } catch (error) {
    logger.error('PRIORITY_URLS_ERROR', `Error finding priority URLs: ${error.message}`);
    return [];
  }
}

