// Hard ceilings for anything an anonymous visitor can send to a public form.
const num = (name: string, fallback: number): number => {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const MAX_UPLOAD_MB = (): number => num("MAX_UPLOAD_MB", 25); // per file
export const MAX_UPLOAD_FILES = (): number => num("MAX_UPLOAD_FILES", 10); // files per submission
export const MAX_ANSWERS_BYTES = (): number => num("MAX_ANSWERS_BYTES", 1024 * 1024); // all answers together

// Values longer than this are not matched against a field pattern.
export const MAX_PATTERN_INPUT = 2000;

const isQuantifierAt = (src: string, i: number): boolean =>
  i < src.length && (src[i] === "+" || src[i] === "*" || (src[i] === "{" && /^\{\d+,?\d*\}/.test(src.slice(i))));

// A field `pattern` is compiled server-side and run against visitor input. Node has no regex
// timeout, so a catastrophic pattern such as (a+)+$ would freeze the whole process for every
// tenant. Accept only patterns that are short, compile, and never repeat a group that itself
// contains a repeat or an alternation (the shapes behind catastrophic backtracking).
// ponytail: conservative on purpose, so a few harmless patterns are refused; move to RE2 if that bites.
export const isSafePattern = (pattern: unknown): boolean => {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > 200) return false;
  try {
    new RegExp(pattern);
  } catch {
    return false;
  }

  // For each open group, remember whether its body has a repeat or an alternation.
  const stack: { risky: boolean }[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
    } else if (ch === "(") {
      stack.push({ risky: false });
    } else if (ch === ")") {
      const group = stack.pop();
      if (group?.risky && isQuantifierAt(pattern, i + 1)) return false;
      if (group?.risky && stack.length) stack[stack.length - 1].risky = true;
    } else if (stack.length && (ch === "|" || isQuantifierAt(pattern, i))) {
      stack[stack.length - 1].risky = true;
    }
  }
  return true;
};
