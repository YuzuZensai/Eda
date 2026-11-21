// The working file may span several reads, including a split inside a marker or its CRLF.
export function scanConflictMarkers(size: number) {
  let marker = "";
  let count = 0;
  let carriageReturn = false;
  let skipLine = false;

  return (chunk: string, endOfFile = false): boolean => {
    for (let offset = 0; offset < chunk.length; offset++) {
      if (skipLine) {
        const newline = chunk.indexOf("\n", offset);
        if (newline < 0) return false;
        offset = newline;
      } else {
        const char = chunk[offset]!;
        if (count === 0 && "<|=>".includes(char)) marker = char;
        if (char === marker && count < size) {
          count++;
          continue;
        }
        if (count === size && !carriageReturn) {
          if (char === " ") return true;
          if (char === "\r") {
            carriageReturn = true;
            continue;
          }
        }
        if (char !== "\n") {
          skipLine = true;
          continue;
        }
        if (count === size) return true;
      }
      skipLine = false;
      marker = "";
      count = 0;
      carriageReturn = false;
    }
    return endOfFile && !skipLine && count === size;
  };
}
