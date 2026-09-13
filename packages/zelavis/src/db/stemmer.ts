/**
 * Language stemming for zelavis/db.
 *
 * Implements Martin Porter's 1980 stemming algorithm for English text.
 * Zero external dependencies, pure functions, fast and deterministic.
 */

const isConsonant = (word: string, i: number): boolean => {
  const ch = word[i];
  if (ch === "a" || ch === "e" || ch === "i" || ch === "o" || ch === "u") return false;
  if (ch === "y") return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
};

/**
 * The measure m of a word stem: [C](VC)^m[V].
 * Measures how many vowel-consonant sequences appear in the stem.
 */
const measure = (stem: string): number => {
  let m = 0;
  let i = 0;
  const len = stem.length;

  while (i < len && isConsonant(stem, i)) i++;
  while (i < len) {
    while (i < len && !isConsonant(stem, i)) i++;
    if (i >= len) break;
    while (i < len && isConsonant(stem, i)) i++;
    m++;
  }
  return m;
};

/** Whether a stem contains any vowel. */
const containsVowel = (stem: string): boolean => {
  for (let i = 0; i < stem.length; i++) {
    if (!isConsonant(stem, i)) return true;
  }
  return false;
};

/** Whether the stem ends with two identical consonants. */
const endsDoubleConsonant = (stem: string): boolean => {
  const len = stem.length;
  if (len < 2) return false;
  return stem[len - 1] === stem[len - 2] && isConsonant(stem, len - 1);
};

/**
 * Whether the stem ends in consonant-vowel-consonant,
 * where the second consonant is not w, x or y.
 */
const cvc = (stem: string): boolean => {
  const len = stem.length;
  if (len < 3) return false;
  const c3 = stem[len - 1]!;
  if (c3 === "w" || c3 === "x" || c3 === "y") return false;
  return isConsonant(stem, len - 1) && !isConsonant(stem, len - 2) && isConsonant(stem, len - 3);
};

/**
 * The Porter Stemming Algorithm for English.
 * Reference: Porter, 1980, "An algorithm for suffix stripping", Program 14(3): 130-137.
 */
export const porterStemmer = (input: string): string => {
  let word = input.toLowerCase();
  if (word.length <= 2) return word;

  // Step 1a
  if (word.endsWith("sses")) {
    word = word.slice(0, -2);
  } else if (word.endsWith("ies")) {
    word = word.slice(0, -2);
  } else if (!word.endsWith("ss") && word.endsWith("s")) {
    word = word.slice(0, -1);
  }

  // Step 1b
  let step1b = false;
  if (word.endsWith("eed")) {
    const stem = word.slice(0, -3);
    if (measure(stem) > 0) word = stem + "ee";
  } else if (word.endsWith("ed")) {
    const stem = word.slice(0, -2);
    if (containsVowel(stem)) {
      word = stem;
      step1b = true;
    }
  } else if (word.endsWith("ing")) {
    const stem = word.slice(0, -3);
    if (containsVowel(stem)) {
      word = stem;
      step1b = true;
    }
  }

  if (step1b) {
    if (word.endsWith("at") || word.endsWith("bl") || word.endsWith("iz")) {
      word += "e";
    } else if (endsDoubleConsonant(word)) {
      const last = word[word.length - 1];
      if (last !== "l" && last !== "s" && last !== "z") {
        word = word.slice(0, -1);
      }
    } else if (measure(word) === 1 && cvc(word)) {
      word += "e";
    }
  }

  // Step 1c
  if (word.endsWith("y")) {
    const stem = word.slice(0, -1);
    if (containsVowel(stem)) {
      word = stem + "i";
    }
  }

  // Step 2
  const step2Replacements: ReadonlyArray<readonly [string, string]> = [
    ["ational", "ate"],
    ["tional", "tion"],
    ["enci", "ence"],
    ["anci", "ance"],
    ["izer", "ize"],
    ["abli", "able"],
    ["alli", "al"],
    ["entli", "ent"],
    ["eli", "e"],
    ["ousli", "ous"],
    ["ization", "ize"],
    ["ation", "ate"],
    ["ator", "ate"],
    ["alism", "al"],
    ["iveness", "ive"],
    ["fulness", "ful"],
    ["ousness", "ous"],
    ["aliti", "al"],
    ["iviti", "ive"],
    ["biliti", "ble"],
  ];
  for (const [suffix, replacement] of step2Replacements) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) {
        word = stem + replacement;
      }
      break;
    }
  }

  // Step 3
  const step3Replacements: ReadonlyArray<readonly [string, string]> = [
    ["icate", "ic"],
    ["ative", ""],
    ["alize", "al"],
    ["iciti", "ic"],
    ["ical", "ic"],
    ["ful", ""],
    ["ness", ""],
  ];
  for (const [suffix, replacement] of step3Replacements) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 0) {
        word = stem + replacement;
      }
      break;
    }
  }

  // Step 4
  const step4Suffixes = [
    "al",
    "ance",
    "ence",
    "er",
    "ic",
    "able",
    "ible",
    "ant",
    "ement",
    "ment",
    "ent",
    "ou",
    "ism",
    "ate",
    "iti",
    "ous",
    "ive",
    "ize",
  ];
  let step4Done = false;
  for (const suffix of step4Suffixes) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (measure(stem) > 1) {
        word = stem;
      }
      step4Done = true;
      break;
    }
  }
  if (!step4Done && (word.endsWith("sion") || word.endsWith("tion"))) {
    const stem = word.slice(0, -3);
    if (measure(stem) > 1) {
      word = stem;
    }
  }

  // Step 5a
  if (word.endsWith("e")) {
    const stem = word.slice(0, -1);
    const m = measure(stem);
    if (m > 1 || (m === 1 && !cvc(stem))) {
      word = stem;
    }
  }

  // Step 5b
  if (measure(word) > 1 && endsDoubleConsonant(word) && word.endsWith("l")) {
    word = word.slice(0, -1);
  }

  return word;
};

/**
 * Language-aware stemmer.
 * Returns the stemmed form of `word` according to `language`, or the input word
 * if `language` is undefined or has no stemmer available.
 */
export const stem = (word: string, language?: string): string => {
  if (language === undefined) return word;
  const lang = language.trim().toLowerCase();
  if (lang === "en" || lang === "english") {
    return porterStemmer(word);
  }
  return word;
};
