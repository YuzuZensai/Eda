const readCommands = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "merge-base",
  "ls-files",
  "ls-tree",
  "blame",
  "cat-file",
  "for-each-ref",
  "config",
  "remote",
  "check-attr",
  "symbolic-ref",
]);
const revisionCommands = new Set([
  "checkout",
  "switch",
  "reset",
  "merge",
  "rebase",
  "read-tree",
  "cherry-pick",
  "revert",
]);

export function classifyCommand(args: readonly string[]) {
  let commandIndex = 0;
  while (args[commandIndex]?.startsWith("-")) {
    commandIndex += args[commandIndex] === "-c" || args[commandIndex] === "-C" ? 2 : 1;
  }
  const command = args[commandIndex] ?? "";
  const revisionArguments: string[] = [];
  if (revisionCommands.has(command)) {
    for (const argument of args.slice(commandIndex + 1)) {
      if (argument === "--") break;
      if (!argument.startsWith("-")) revisionArguments.push(argument);
    }
  }
  return {
    command,
    revisionArguments,
    isReadOnly:
      readCommands.has(command) || (command === "worktree" && args[commandIndex + 1] === "list"),
  };
}
