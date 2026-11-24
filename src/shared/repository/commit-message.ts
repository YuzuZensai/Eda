export function splitCommitMessage(message: string) {
  const firstBreak = message.indexOf("\n");
  const title = firstBreak < 0 ? message : message.slice(0, firstBreak).replace(/\r$/, "");
  const messageTail = firstBreak < 0 ? "" : message.slice(firstBreak);
  const description = messageTail.replace(/^\r?\n(?:\r?\n)?/, "");

  return { title, messageTail, description };
}
