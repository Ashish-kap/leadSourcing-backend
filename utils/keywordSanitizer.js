/**
 * Keyword Sanitization Utility
 * Cleans and normalizes user input keywords for scraping
 */

/**
 * Sanitizes and cleans a keyword string
 * @param {string} keyword - Raw keyword input from user
 * @returns {object} - { cleaned: string, original: string, warnings: array }
 */
export function sanitizeKeyword(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      cleaned: '',
      original: keyword || '',
      warnings: ['Invalid keyword input'],
      isValid: false
    };
  }

  const original = keyword;
  const warnings = [];
  let cleaned = keyword;

  // Step 1: Remove extra quotes and escape characters
  cleaned = cleaned
    .replace(/^["']+|["']+$/g, '') // Remove leading/trailing quotes
    .replace(/\\"/g, '"') // Unescape quotes
    .replace(/\\'/g, "'") // Unescape single quotes
    .replace(/\\n/g, ' ') // Replace escaped newlines with spaces
    .replace(/\\t/g, ' ') // Replace escaped tabs with spaces
    .replace(/\\r/g, ' ') // Replace escaped carriage returns with spaces
    .trim();

  // Step 2: Remove common punctuation and separators
  cleaned = cleaned
    .replace(/[,;|&]+/g, ' ') // Replace commas, semicolons, pipes, ampersands with spaces
    .replace(/[(){}[\]]/g, ' ') // Remove brackets and parentheses
    .replace(/[!@#$%^*+=<>?~`]/g, ' ') // Remove special characters
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim();

  // Step 3: Remove common filler words and phrases
  const fillerWords = [
    'type anything',
    'anything',
    'random',
    'test',
    'sample',
    'example',
    'demo',
    'lorem ipsum',
    'asdf',
    'qwerty',
    '123',
    'abc',
    'xyz'
  ];

  const words = cleaned.toLowerCase().split(' ');
  const filteredWords = words.filter(word => {
    if (fillerWords.includes(word)) {
      warnings.push(`Removed filler word: "${word}"`);
      return false;
    }
    return true;
  });

  cleaned = filteredWords.join(' ').trim();

  // Step 4: Validate and clean up
  if (cleaned.length === 0) {
    return {
      cleaned: '',
      original,
      warnings: [...warnings, 'Keyword became empty after cleaning'],
      isValid: false
    };
  }

  // Step 5: Length validation
  if (cleaned.length < 2) {
    warnings.push('Keyword is very short (less than 2 characters)');
  }

  if (cleaned.length > 100) {
    cleaned = cleaned.substring(0, 100).trim();
    warnings.push('Keyword truncated to 100 characters');
  }

  // Step 6: Check for suspicious patterns
  if (cleaned.match(/^\d+$/)) {
    warnings.push('Keyword contains only numbers');
  }

  if (cleaned.match(/^[^a-zA-Z0-9\s]+$/)) {
    warnings.push('Keyword contains only special characters');
  }

  // Step 7: Final validation
  const isValid = cleaned.length >= 2 && 
                  cleaned.length <= 100 && 
                  /[a-zA-Z]/.test(cleaned); // Must contain at least one letter

  return {
    cleaned,
    original,
    warnings,
    isValid,
    wordCount: cleaned.split(' ').length
  };
}

/**
 * Sanitizes multiple keywords (for future use)
 * @param {string[]} keywords - Array of raw keywords
 * @returns {object[]} - Array of sanitized keyword objects
 */
export function sanitizeKeywords(keywords) {
  if (!Array.isArray(keywords)) {
    return [];
  }

  return keywords.map(keyword => sanitizeKeyword(keyword));
}

/**
 * Detects and splits multiple keywords from a single input
 * @param {string} input - Raw input that might contain multiple keywords
 * @returns {object} - { keywords: string[], isMultiple: boolean, separator: string }
 */
export function detectMultipleKeywords(input) {
  if (!input || typeof input !== 'string') {
    return { keywords: [], isMultiple: false, separator: null };
  }

  // Common separators for multiple keywords
  const separators = [
    { pattern: /,/, name: 'comma' },
    { pattern: /;/, name: 'semicolon' },
    { pattern: /\|/, name: 'pipe' },
    { pattern: /&/, name: 'ampersand' },
    { pattern: /\n/, name: 'newline' },
    { pattern: /\r\n/, name: 'carriage_return' }
  ];

  // Find the most likely separator
  let bestSeparator = null;
  let maxOccurrences = 0;

  for (const sep of separators) {
    const matches = input.match(new RegExp(sep.pattern.source, 'g'));
    const count = matches ? matches.length : 0;
    
    if (count > maxOccurrences) {
      maxOccurrences = count;
      bestSeparator = sep;
    }
  }

  // If we found a separator with multiple occurrences, split the input
  if (bestSeparator && maxOccurrences > 0) {
    const keywords = input
      .split(bestSeparator.pattern)
      .map(k => k.trim())
      .filter(k => k.length > 0);

    return {
      keywords,
      isMultiple: keywords.length > 1,
      separator: bestSeparator.name,
      originalInput: input
    };
  }

  // Check for common "and" patterns
  const andPatterns = [
    /\s+and\s+/gi,
    /\s+&\s+/gi,
    /\s+plus\s+/gi
  ];

  for (const pattern of andPatterns) {
    if (pattern.test(input)) {
      const keywords = input
        .split(pattern)
        .map(k => k.trim())
        .filter(k => k.length > 0);

      if (keywords.length > 1) {
        return {
          keywords,
          isMultiple: true,
          separator: 'and',
          originalInput: input
        };
      }
    }
  }

  // Single keyword
  return {
    keywords: [input.trim()],
    isMultiple: false,
    separator: null,
    originalInput: input
  };
}

/**
 * Sanitizes input that might contain multiple keywords
 * @param {string} input - Raw input from user
 * @returns {object} - { keywords: object[], isMultiple: boolean, recommendations: string[] }
 */
export function sanitizeMultipleKeywords(input) {
  const detection = detectMultipleKeywords(input);
  const recommendations = [];

  if (detection.isMultiple) {
    // Sanitize each keyword individually
    const sanitizedKeywords = detection.keywords.map(keyword => {
      const result = sanitizeKeyword(keyword);
      return {
        ...result,
        original: keyword
      };
    });

    // Filter out invalid keywords
    const validKeywords = sanitizedKeywords.filter(k => k.isValid);
    const invalidKeywords = sanitizedKeywords.filter(k => !k.isValid);

    if (invalidKeywords.length > 0) {
      recommendations.push(`Removed ${invalidKeywords.length} invalid keyword(s): ${invalidKeywords.map(k => `"${k.original}"`).join(', ')}`);
    }

    if (validKeywords.length === 0) {
      return {
        keywords: [],
        isMultiple: false,
        recommendations: ['No valid keywords found'],
        error: 'All keywords were invalid'
      };
    }

    if (validKeywords.length > 5) {
      recommendations.push('Consider using fewer keywords (5 or less) for better results');
    }

    return {
      keywords: validKeywords,
      isMultiple: true,
      separator: detection.separator,
      recommendations,
      originalInput: detection.originalInput
    };
  } else {
    // Single keyword
    const result = sanitizeKeyword(detection.keywords[0]);
    return {
      keywords: [result],
      isMultiple: false,
      recommendations: result.warnings,
      originalInput: detection.originalInput
    };
  }
}

/**
 * Validates if a keyword is suitable for scraping
 * @param {string} keyword - Cleaned keyword
 * @returns {object} - Validation result
 */
export function validateKeyword(keyword) {
  const issues = [];
  const suggestions = [];

  if (!keyword || keyword.length < 2) {
    issues.push('Keyword too short');
    suggestions.push('Use at least 2 characters');
  }

  if (keyword.length > 100) {
    issues.push('Keyword too long');
    suggestions.push('Keep under 100 characters');
  }

  if (!/[a-zA-Z]/.test(keyword)) {
    issues.push('No letters found');
    suggestions.push('Include at least one letter');
  }

  if (keyword.split(' ').length > 10) {
    issues.push('Too many words');
    suggestions.push('Use 10 words or less');
  }

  // Check for common business-related terms
  const businessTerms = [
    'restaurant', 'hotel', 'clinic', 'hospital', 'school', 'gym', 'salon',
    'spa', 'dentist', 'lawyer', 'accountant', 'plumber', 'electrician',
    'contractor', 'real estate', 'insurance', 'bank', 'pharmacy'
  ];

  const hasBusinessTerm = businessTerms.some(term => 
    keyword.toLowerCase().includes(term)
  );

  if (!hasBusinessTerm) {
    suggestions.push('Consider including business type (e.g., "restaurant", "clinic")');
  }

  return {
    isValid: issues.length === 0,
    issues,
    suggestions
  };
}

/**
 * Sanitizes keyword while preserving separators for multiple keywords
 * @param {string} keyword - Raw keyword input from user
 * @returns {object} - { cleaned: string, original: string, warnings: array }
 */
export function sanitizeKeywordWithSeparators(keyword) {
  if (!keyword || typeof keyword !== 'string') {
    return {
      cleaned: '',
      original: keyword || '',
      warnings: ['Invalid keyword input'],
      isValid: false
    };
  }

  const original = keyword;
  const warnings = [];
  let cleaned = keyword;

  // Step 1: Remove extra quotes and escape characters (but preserve separators)
  cleaned = cleaned
    .replace(/^["']+|["']+$/g, '') // Remove leading/trailing quotes
    .replace(/\\"/g, '"') // Unescape quotes
    .replace(/\\'/g, "'") // Unescape single quotes
    .replace(/\\n/g, ' ') // Replace escaped newlines with spaces
    .replace(/\\t/g, ' ') // Replace escaped tabs with spaces
    .replace(/\\r/g, ' ') // Replace escaped carriage returns with spaces
    .replace(/\\+$/g, '') // Remove trailing backslashes
    .replace(/^\\+/g, '') // Remove leading backslashes
    .replace(/^["']+|["']+$/g, '') // Remove quotes again after unescaping
    .trim();

  // Step 2: Remove unwanted punctuation but preserve separators
  cleaned = cleaned
    .replace(/[(){}[\]]/g, ' ') // Remove brackets and parentheses
    .replace(/[!@#$%^*+=<>?~`]/g, ' ') // Remove special characters
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .trim();

  // Step 3: Remove common filler words and phrases
  const fillerWords = [
    'type anything',
    'anything',
    'random',
    'test',
    'sample',
    'example',
    'demo',
    'lorem ipsum',
    'asdf',
    'qwerty',
    '123',
    'abc',
    'xyz'
  ];

  // Split by separators to preserve them
  const separatorPattern = /([,;|&])/g;
  const parts = cleaned.split(separatorPattern);
  
  const processedParts = parts.map(part => {
    if ([',', ';', '|', '&'].includes(part)) {
      return part; // Keep separators as-is
    }
    
    const words = part.trim().toLowerCase().split(' ');
    const filteredWords = words.filter(word => {
      if (fillerWords.includes(word)) {
        warnings.push(`Removed filler word: "${word}"`);
        return false;
      }
      return true;
    });
    
    return filteredWords.join(' ');
  });

  cleaned = processedParts.join('').trim();

  // Step 4: Validate and clean up
  if (cleaned.length === 0) {
    return {
      cleaned: '',
      original,
      warnings: [...warnings, 'Keyword became empty after cleaning'],
      isValid: false
    };
  }

  // Step 5: Length validation
  if (cleaned.length < 2) {
    warnings.push('Keyword is very short (less than 2 characters)');
  }

  if (cleaned.length > 200) {
    cleaned = cleaned.substring(0, 200).trim();
    warnings.push('Keyword truncated to 200 characters');
  }

  // Step 6: Check for suspicious patterns
  if (cleaned.match(/^\d+$/)) {
    warnings.push('Keyword contains only numbers');
  }

  if (cleaned.match(/^[^a-zA-Z0-9\s,;|&]+$/)) {
    warnings.push('Keyword contains only special characters');
  }

  // Step 7: Final validation - must contain at least one letter
  const isValid = cleaned.length >= 2 && 
                  cleaned.length <= 200 && 
                  /[a-zA-Z]/.test(cleaned);

  return {
    cleaned,
    original,
    warnings,
    isValid,
    hasSeparators: /[,;|&]/.test(cleaned),
    separatorCount: (cleaned.match(/[,;|&]/g) || []).length
  };
}

/**
 * Example usage and testing
 */
export function testSanitization() {
  const testCases = [
    '"hand therapist"',
    '"hand therapist",',
    'type anything',
    'restaurant, cafe, food',
    'dentist | doctor | clinic',
    'test123',
    '   spa   ',
    'lorem ipsum dolor',
    'asdf qwerty',
    'real estate agent',
    '\\"escaped quotes\\"',
    'multiple    spaces',
    'special@chars#here',
    'very long keyword that goes on and on and should be truncated because it exceeds the maximum length limit',
    '123',
    '!!!',
    ''
  ];

  console.log('Keyword Sanitization Test Results:');
  console.log('=====================================');

  testCases.forEach((testCase, index) => {
    const result = sanitizeKeyword(testCase);
    console.log(`\nTest ${index + 1}: "${testCase}"`);
    console.log(`Cleaned: "${result.cleaned}"`);
    console.log(`Valid: ${result.isValid}`);
    if (result.warnings.length > 0) {
      console.log(`Warnings: ${result.warnings.join(', ')}`);
    }
  });
}
