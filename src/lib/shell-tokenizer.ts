// Minimal POSIX tokenizer: faithful port of Python's shlex with
// posix=True, punctuation_chars=True and whitespace_split=True.
// Operators ();<>|& become their own tokens (grouped runs: "&&", ">&").
// Unbalanced quotes (or a pending escape at the end) raise UnbalancedQuotesError,
// mirroring the shlex ValueError.

const PUNCTUATION_CHARS = "();<>|&";
const WHITESPACE = " \t\r\n";
const QUOTES = "'\"";
const ESCAPE = "\\";
// inside double quotes the backslash escapes only the quote and the backslash itself
const ESCAPED_QUOTES = '"';
const COMMENTERS = "#";

export class UnbalancedQuotesError extends Error {}

export function tokenize(cmd: string): string[] {
  const tokens: string[] = [];
  const pushback: string[] = [];
  let pos = 0;
  // state persists between tokens, as in shlex
  let state: string | null = " ";

  const readChar = (): string => {
    if (pushback.length > 0) return pushback.pop() as string;
    if (pos < cmd.length) return cmd.charAt(pos++);
    return "";
  };

  const skipComment = (): void => {
    // shlex readline: consumes to the end of the line, including the \n
    while (pos < cmd.length && cmd.charAt(pos) !== "\n") pos++;
    if (pos < cmd.length) pos++;
  };

  while (state !== null) {
    // equivalent to one read_token call
    let token = "";
    let quoted = false;
    let escapedState = " ";

    reading: while (true) {
      const ch = readChar();
      if (state === null) break reading;

      if (state === " ") {
        if (ch === "") {
          state = null;
          break reading;
        }
        if (WHITESPACE.includes(ch)) {
          if (token !== "" || quoted) break reading;
          continue;
        }
        if (COMMENTERS.includes(ch)) {
          skipComment();
          continue;
        }
        if (ch === ESCAPE) {
          escapedState = "a";
          state = ESCAPE;
          continue;
        }
        if (PUNCTUATION_CHARS.includes(ch)) {
          token = ch;
          state = "c";
          continue;
        }
        if (QUOTES.includes(ch)) {
          state = ch;
          continue;
        }
        token = ch;
        state = "a";
        continue;
      }

      if (QUOTES.includes(state)) {
        quoted = true;
        if (ch === "") throw new UnbalancedQuotesError("No closing quotation");
        if (ch === state) {
          state = "a";
          continue;
        }
        if (ch === ESCAPE && ESCAPED_QUOTES.includes(state)) {
          escapedState = state;
          state = ESCAPE;
          continue;
        }
        token += ch;
        continue;
      }

      if (state === ESCAPE) {
        if (ch === "") throw new UnbalancedQuotesError("No escaped character");
        // inside double quotes only the quote and the backslash are escapable; the rest keeps the backslash
        if (QUOTES.includes(escapedState) && ch !== state && ch !== escapedState) {
          token += state;
        }
        token += ch;
        state = escapedState;
        continue;
      }

      // state "a" (word) or "c" (operator run)
      if (ch === "") {
        state = null;
        break reading;
      }
      if (WHITESPACE.includes(ch)) {
        state = " ";
        if (token !== "" || quoted) break reading;
        continue;
      }
      if (COMMENTERS.includes(ch)) {
        skipComment();
        state = " ";
        if (token !== "" || quoted) break reading;
        continue;
      }
      if (state === "c") {
        if (PUNCTUATION_CHARS.includes(ch)) {
          token += ch;
          continue;
        }
        pushback.push(ch);
        state = " ";
        break reading;
      }
      if (QUOTES.includes(ch)) {
        state = ch;
        continue;
      }
      if (ch === ESCAPE) {
        escapedState = "a";
        state = ESCAPE;
        continue;
      }
      if (!PUNCTUATION_CHARS.includes(ch)) {
        token += ch;
        continue;
      }
      pushback.push(ch);
      state = " ";
      break reading;
    }

    // posix: also emit the empty token coming from quotes ('')
    if (token !== "" || quoted) tokens.push(token);
  }
  return tokens;
}
