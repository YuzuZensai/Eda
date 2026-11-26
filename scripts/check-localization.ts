import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

type Message = string | Record<string, string>;
type Messages = Record<string, Message>;
const categories = new Set(["zero", "one", "two", "few", "many", "other"]);
const compareKeys = new Intl.Collator("en").compare;
const parameters = (message: string): string[] =>
  [
    ...new Set([
      ...[...message.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map((match) => match[1]!),
      ...[...message.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\s*\/>/g)].map((match) => match[1]!),
    ]),
  ].sort();
const variants = (message: Message): string[] =>
  typeof message === "string" ? [message] : Object.values(message);

interface LocalizationReport {
  files: { path: string; keyCount: number | null }[];
  localeCount: number;
  issues: string[];
}

interface LocalizationLogger {
  log(message: string): void;
  error(message: string): void;
}

function checkAlphabeticalOrder(
  keys: string[],
  location: string,
  recordIssue: (message: string) => void,
): void {
  const index = keys.findIndex((key, i) => i > 0 && compareKeys(keys[i - 1]!, key) > 0);
  if (index !== -1)
    recordIssue(
      `${location}: alphabetical order requires ${keys[index]} before ${keys[index - 1]}`,
    );
}

export function checkLocalization(root: string, logger?: LocalizationLogger): LocalizationReport {
  const report: LocalizationReport = { files: [], localeCount: 0, issues: [] };
  const recordIssue = (message: string) => {
    report.issues.push(message);
    logger?.error(message);
  };
  const recordCatalog = (path: string, keyCount: number | null) => {
    report.files.push({ path, keyCount });
    logger?.log(`  ${path} (${keyCount === null ? "invalid catalog" : `${keyCount} keys`})`);
  };

  const catalogDirectory = "src/shared/locales";
  const directory = join(root, catalogDirectory);
  if (!existsSync(directory)) {
    recordIssue(`${catalogDirectory}: localization directory is missing`);
    return report;
  }

  const catalogs = new Map<string, Messages>();
  const keyLocations: { key: string; location: string }[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    report.localeCount++;
    const localePath = `${catalogDirectory}/${entry.name}`;
    try {
      if (Intl.getCanonicalLocales(entry.name)[0] !== entry.name)
        recordIssue(`${localePath}: use a canonical BCP-47 locale directory`);
    } catch {
      recordIssue(`${localePath}: invalid BCP-47 locale directory`);
    }
    const messages: Messages = {};
    for (const file of readdirSync(join(directory, entry.name)).filter((name) =>
      name.endsWith(".json"),
    )) {
      const catalogPath = `${localePath}/${file}`;
      const contents = readFileSync(join(root, catalogPath), "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        recordCatalog(catalogPath, null);
        recordIssue(`${catalogPath}: invalid JSON (${detail})`);
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        recordCatalog(catalogPath, null);
        recordIssue(`${catalogPath}: expected a JSON object of message keys`);
        continue;
      }

      const data = parsed as Messages;
      const keys = Object.keys(data);
      recordCatalog(catalogPath, keys.length);

      const json = ts.parseJsonText(file, contents);
      const statement = json.statements[0];
      if (
        statement &&
        ts.isExpressionStatement(statement) &&
        ts.isObjectLiteralExpression(statement.expression)
      ) {
        const keys = new Set<string>();
        for (const property of statement.expression.properties) {
          if (!property.name || !ts.isStringLiteral(property.name)) continue;
          if (keys.has(property.name.text))
            recordIssue(`${catalogPath}: duplicate key ${property.name.text}`);
          keys.add(property.name.text);
        }
      }
      checkAlphabeticalOrder(keys, catalogPath, recordIssue);
      for (const [key, message] of Object.entries(data)) {
        const location = `${catalogPath}: ${key}`;
        keyLocations.push({ key, location });
        if (Object.hasOwn(messages, key)) recordIssue(`${location}: duplicate key across catalogs`);
        if (!/^(?:[a-z][a-zA-Z0-9]*\.)+[a-z][a-zA-Z0-9]*$/.test(key))
          recordIssue(`${location}: use dot-separated lowerCamelCase keys`);
        if (
          typeof message !== "string" &&
          (!message ||
            typeof message !== "object" ||
            Array.isArray(message) ||
            !Object.hasOwn(message, "other"))
        ) {
          recordIssue(`${location}: plural messages require an other form`);
          continue;
        }
        if (
          typeof message !== "string" &&
          Object.keys(message).some((form) => !categories.has(form))
        )
          recordIssue(`${location}: invalid plural category`);
        if (typeof message !== "string")
          checkAlphabeticalOrder(Object.keys(message), location, recordIssue);
        const forms = variants(message);
        if (forms.some((form) => typeof form !== "string" || !form.trim())) {
          recordIssue(`${location}: empty or invalid message`);
          continue;
        }
        if (
          forms.some(
            (form) => JSON.stringify(parameters(form)) !== JSON.stringify(parameters(forms[0]!)),
          )
        )
          recordIssue(`${location}: plural forms must preserve named parameters`);
        messages[key] = message;
      }
    }
    catalogs.set(entry.name, messages);
  }
  const english = catalogs.get("en");
  if (!english) {
    recordIssue(`${catalogDirectory}: missing English catalogs`);
    return report;
  }
  for (const [locale, messages] of catalogs) {
    if (locale === "en") continue;
    const localePath = `${catalogDirectory}/${locale}`;
    for (const [key, message] of Object.entries(messages)) {
      if (!Object.hasOwn(english, key)) recordIssue(`${localePath}: unknown key ${key}`);
      else if (typeof english[key] !== "string" && typeof message === "string")
        recordIssue(`${localePath}: ${key}: preserve plural message forms`);
      else if (
        JSON.stringify(parameters(variants(message)[0]!)) !==
        JSON.stringify(parameters(variants(english[key]!)[0]!))
      )
        recordIssue(`${localePath}: ${key}: parameters differ from English`);
    }
  }

  const src = join(root, "src");
  const files = readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
  logger?.log(`Checking application references in ${files.length} TypeScript files.`);

  const configPath = join(root, "tsconfig.json");
  const options: ts.CompilerOptions = existsSync(configPath)
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(configPath, ts.sys.readFile).config,
        ts.sys,
        root,
      ).options
    : { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX };
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const i18n = program.getSourceFile(join(src, "shared/i18n/index.ts"));
  const module = i18n && checker.getSymbolAtLocation(i18n);
  const keySymbol =
    module && checker.getExportsOfModule(module).find((s) => s.name === "MessageKey");
  const keyType = keySymbol && checker.getDeclaredTypeOfSymbol(keySymbol);
  const usedKeys = new Set<string>();

  const recordKeyReference = (expression: ts.Expression): void => {
    if (ts.isStringLiteralLike(expression) && !Object.hasOwn(english, expression.text)) return;
    const context = checker.getContextualType(expression);
    if (!context || checker.getNonNullableType(context) !== keyType) return;
    if (ts.isStringLiteralLike(expression)) {
      usedKeys.add(expression.text);
      return;
    }
    const type = checker.getTypeAtLocation(expression);
    // A value typed as MessageKey can forward any key. Its inputs provide the actual references.
    if (checker.getNonNullableType(type) === keyType) return;

    for (const candidate of type.isUnion() ? type.types : [type]) {
      if (candidate.isStringLiteral()) usedKeys.add(candidate.value);
    }
  };

  const reported = new Set<string>();
  for (const file of files) {
    const source = program.getSourceFile(file)!;
    const report = (node: ts.Node, message: string) => {
      const owner = node.getSourceFile();
      const location = `${owner.fileName}:${node.getStart(owner)}`;
      if (reported.has(location)) return;
      reported.add(location);
      const { line } = owner.getLineAndCharacterOfPosition(node.getStart(owner));
      recordIssue(`${relative(root, owner.fileName)}:${line + 1}: ${message}`);
    };
    const human = isTranslatable;
    const checkVisibleExpression = (expression: ts.Expression): void => {
      if (
        (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) &&
        human(expression.text)
      )
        report(expression, "move visible expression text into a JSON catalog");
      else if (ts.isConditionalExpression(expression)) {
        checkVisibleExpression(expression.whenTrue);
        checkVisibleExpression(expression.whenFalse);
      } else if (ts.isParenthesizedExpression(expression))
        checkVisibleExpression(expression.expression);
      else if (
        ts.isBinaryExpression(expression) &&
        [
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
        ].includes(expression.operatorToken.kind)
      )
        checkVisibleExpression(expression.right);
      else if (ts.isTemplateExpression(expression)) {
        const parts = [
          expression.head.text,
          ...expression.templateSpans.map((span) => span.literal.text),
        ];
        if (parts.some((part) => /[a-zA-Z]{2,}/.test(part) && human(part)))
          report(expression, "move the complete visible template into a JSON catalog");
      }
    };
    const visit = (node: ts.Node): void => {
      if (keyType) {
        if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) recordKeyReference(node);
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          for (const argument of node.arguments ?? []) {
            if (!ts.isStringLiteralLike(argument) && !ts.isTemplateExpression(argument))
              recordKeyReference(argument);
          }
        }
        if (ts.isJsxExpression(node) && ts.isJsxAttribute(node.parent) && node.expression)
          recordKeyReference(node.expression);
      }
      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        (!ts.isJsxAttribute(node.parent) || isTextAttribute(node.parent))
      )
        checkVisibleExpression(node.expression);
      if (ts.isJsxText(node) && human(node.text))
        report(node, "move visible JSX text into a JSON catalog");
      if (
        ts.isJsxAttribute(node) &&
        isTextAttribute(node) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        human(node.initializer.text)
      )
        report(node, "move visible attribute text into a JSON catalog");
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        ["t", "errorText"].includes(node.expression.text)
      ) {
        const key = node.arguments[0];
        const values = node.arguments[1];
        if (key && ts.isStringLiteral(key)) {
          const message = english[key.text];
          if (!message) report(key, `unknown message key ${key.text}`);
          else {
            const required = parameters(variants(message)[0]!);
            if (!values && required.length)
              report(key, `missing parameters: ${required.join(", ")}`);
            else if (
              values &&
              ts.isObjectLiteralExpression(values) &&
              !values.properties.some(ts.isSpreadAssignment)
            ) {
              const names = values.properties.map((property) =>
                property.name &&
                (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
                  ? property.name.text
                  : "",
              );
              const missing = required.filter((name) => !names.includes(name));
              if (missing.length) report(values, `missing parameters: ${missing.join(", ")}`);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const issue of translationMisuses(source, checker)) report(issue.node, issue.message);
    for (const sink of textSinks(source, checker)) {
      for (const literal of displayLiterals(sink.expression, checker))
        report(literal, `move ${sink.reason} text into a JSON catalog`);
    }
  }
  if (!keyType) recordIssue("src/shared/i18n/index.ts: cannot find the MessageKey type");
  else {
    for (const { key, location } of keyLocations) {
      if (Object.hasOwn(english, key) && !usedKeys.has(key)) recordIssue(`${location}: unused key`);
    }
  }
  return report;
}

const textProperties = new Set([
  "title",
  "description",
  "label",
  "hint",
  "detail",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "alt",
  "tooltip",
  "ariaLabel",
  "error",
  "confirmLabel",
  "cancelLabel",
  "emptyLabel",
  "loadingLabel",
  "successLabel",
  "errorLabel",
  "placeholder",
  "message",
  "suggestedAction",
  "reason",
  "unavailableReason",
  "completedLabel",
  "strengthLabel",
  "blurLabel",
  "emptyTitle",
  "emptyDescription",
  "summary",
  "buttons",
  "operation",
  "sampleCommits",
]);
const namedPanels = new Set(["PanelControls", "CollapsiblePanel", "RepositoryPanelState"]);
const displayParameters = new Set([
  "operation",
  "sampleCommits",
  "field",
  "label",
  "suggestedAction",
]);
const messageSetters = new Set(["setError", "setFeedback", "setNotice", "setResult"]);

interface TextSink {
  expression: ts.Expression;
  reason: string;
}
const propertyName = (name: ts.Node): string | undefined =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;

function isTextAttribute(attribute: ts.JsxAttribute): boolean {
  const name = attribute.name.getText();
  if (textProperties.has(name)) return true;
  const tag = attribute.parent.parent.tagName.getText().split(".").at(-1)!;
  return (
    (name === "name" && namedPanels.has(tag)) ||
    (name === "kind" && tag === "TransferProgress") ||
    (name === "value" && ["Input", "Textarea"].includes(tag))
  );
}

function isTranslatable(value: string): boolean {
  return (
    /[a-zA-Z]/.test(value) &&
    !/^\.[a-zA-Z0-9]+$/.test(value.trim()) &&
    !/^(?:\p{Extended_Pictographic}\uFE0F?\s*)?(?:feat|fix|docs|refactor|chore|test|style|perf):\s*$/u.test(
      value,
    ) &&
    !/^[a-z][a-zA-Z0-9_-]*(?:[.:][a-zA-Z0-9_-]+)+$/.test(value.trim()) &&
    !/^(?:[A-Z]|SSH|GPG|HEAD|MIT|HTTPS|GPL-[0-9.]+|URL|Eda|Git|GitHub|GitLab|Bitbucket|Azure DevOps|[\w.-]+@[\w.-]+|[\w.-]+\.(?:md|ts|tsx|json)|https?:\/\/\S+|px|KB|MB|GB|\{(?:base|current|incoming|result)\})$/.test(
      value.trim(),
    )
  );
}

// Follow values that reach the UI, not conditions or translation keys.
function displayLiterals(
  expression: ts.Expression,
  checker?: ts.TypeChecker,
  visited = new Set<ts.Node>(),
): ts.Expression[] {
  if (visited.has(expression)) return [];
  visited.add(expression);
  const follow = (node: ts.Expression) => displayLiterals(node, checker, visited);
  if (ts.isStringLiteralLike(expression))
    return isTranslatable(expression.text) ? [expression] : [];
  if (ts.isArrayLiteralExpression(expression))
    return expression.elements.flatMap((item) => (ts.isExpression(item) ? follow(item) : []));
  if (ts.isConditionalExpression(expression))
    return [...follow(expression.whenTrue), ...follow(expression.whenFalse)];
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression)
  )
    return follow(expression.expression);
  if (
    ts.isBinaryExpression(expression) &&
    [
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
      ts.SyntaxKind.AmpersandAmpersandToken,
    ].includes(expression.operatorToken.kind)
  )
    return expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      ? follow(expression.right)
      : [...follow(expression.left), ...follow(expression.right)];
  if (ts.isTemplateExpression(expression)) {
    const text =
      expression.head.text + expression.templateSpans.map((span) => span.literal.text).join("");
    if (
      !/\s/.test(text) &&
      /^[a-z][\w-]*\.$/.test(expression.head.text) &&
      expression.templateSpans.every((span) => /^[.:_-]*$/.test(span.literal.text))
    )
      return [];
    if (/[a-zA-Z]{2,}/.test(text) && isTranslatable(text)) return [expression];
    return expression.templateSpans.flatMap((span) => follow(span.expression));
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "t"
  ) {
    const values = expression.arguments[1];
    if (values && ts.isObjectLiteralExpression(values))
      return values.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) ? follow(property.initializer) : [],
      );
    return [];
  }
  if (ts.isIdentifier(expression) && checker) {
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return follow(declaration.initializer);
  }
  if (ts.isElementAccessExpression(expression)) {
    let owner: ts.Expression = expression.expression;
    while (ts.isParenthesizedExpression(owner)) owner = owner.expression;
    if (ts.isObjectLiteralExpression(owner))
      return owner.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) ? follow(property.initializer) : [],
      );
  }
  if (ts.isCallExpression(expression) && checker) {
    const signature = checker.getResolvedSignature(expression);
    const declaration = signature?.declaration;
    const type = signature?.getReturnType();
    const stringResult =
      type &&
      (type.flags & ts.TypeFlags.StringLike ||
        (type.isUnion() &&
          type.types.every(
            (part) =>
              !!(
                part.flags &
                (ts.TypeFlags.StringLike |
                  ts.TypeFlags.Null |
                  ts.TypeFlags.Undefined |
                  ts.TypeFlags.Never)
              ),
          )));
    if (
      stringResult &&
      declaration?.getSourceFile().fileName.replaceAll("\\", "/").includes("/src/") &&
      !declaration.getSourceFile().fileName.replaceAll("\\", "/").includes("/shared/i18n/") &&
      "body" in declaration &&
      declaration.body
    ) {
      const returned: ts.Expression[] = [];
      const returns = (node: ts.Node): void => {
        if (ts.isReturnStatement(node) && node.expression) returned.push(node.expression);
        else if (!ts.isFunctionLike(node)) ts.forEachChild(node, returns);
      };
      if (ts.isBlock(declaration.body)) returns(declaration.body);
      else if (ts.isExpression(declaration.body)) returned.push(declaration.body);
      return returned.flatMap(follow);
    }
  }
  return [];
}

function nativeFilterName(node: ts.PropertyAssignment): boolean {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor && !ts.isCallExpression(ancestor)) {
    if (ts.isPropertyAssignment(ancestor) && propertyName(ancestor.name) === "filters") return true;
    ancestor = ancestor.parent;
  }
  return false;
}

function displayTableValue(node: ts.PropertyAssignment): boolean {
  let ancestor: ts.Node | undefined = node.parent;
  while (ancestor && !ts.isStatement(ancestor)) {
    if (ts.isJsxAttribute(ancestor)) {
      const tag = ancestor.parent.parent.tagName.getText().split(".").at(-1)!;
      return (
        (ancestor.name.getText() === "items" && tag === "DefinitionList") ||
        (ancestor.name.getText() === "values" && tag === "Localized")
      );
    }
    ancestor = ancestor.parent;
  }
  return false;
}

const technicalProperties = new Set([
  "stdin",
  "args",
  "className",
  "d",
  "href",
  "src",
  "id",
  "htmlFor",
  "aria-controls",
  "aria-labelledby",
]);

function containsTranslation(node: ts.Node): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t")
    return true;
  return ts.forEachChild(node, containsTranslation) ?? false;
}

function translatedValue(
  node: ts.Node,
  checker: ts.TypeChecker,
  seen = new Set<ts.Node>(),
): boolean {
  if (seen.has(node)) return false;
  seen.add(node);
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer)
      return translatedValue(declaration.initializer, checker, seen);
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t")
    return true;
  if (ts.isConditionalExpression(node))
    return (
      translatedValue(node.whenTrue, checker, seen) ||
      translatedValue(node.whenFalse, checker, seen)
    );
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node)
  )
    return translatedValue(node.expression, checker, seen);
  if (ts.isTemplateExpression(node))
    return node.templateSpans.some((span) => translatedValue(span.expression, checker, seen));
  if (
    ts.isBinaryExpression(node) &&
    [
      ts.SyntaxKind.PlusToken,
      ts.SyntaxKind.QuestionQuestionToken,
      ts.SyntaxKind.BarBarToken,
    ].includes(node.operatorToken.kind)
  )
    return translatedValue(node.left, checker, seen) || translatedValue(node.right, checker, seen);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ["toLowerCase", "toLocaleLowerCase", "toUpperCase", "toLocaleUpperCase", "trim"].includes(
      node.expression.name.text,
    )
  )
    return translatedValue(node.expression.expression, checker, seen);
  return false;
}

function translationMisuses(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): { node: ts.Node; message: string }[] {
  const issues: { node: ts.Node; message: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      technicalProperties.has(propertyName(node.name) ?? "") &&
      containsTranslation(node.initializer)
    )
      issues.push({
        node: node.initializer,
        message: `translation used in protocol property ${node.name.getText(source)}`,
      });
    if (
      ts.isJsxAttribute(node) &&
      technicalProperties.has(node.name.getText(source)) &&
      node.initializer &&
      containsTranslation(node.initializer)
    )
      issues.push({
        node: node.initializer,
        message: `translation used in technical attribute ${node.name.getText(source)}`,
      });
    if (ts.isTaggedTemplateExpression(node) && containsTranslation(node.template))
      issues.push({ node: node.template, message: "translation used in a tagged code template" });
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.EqualsEqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsEqualsToken,
        ts.SyntaxKind.EqualsEqualsToken,
        ts.SyntaxKind.ExclamationEqualsToken,
      ].includes(node.operatorToken.kind) &&
      (translatedValue(node.left, checker) || translatedValue(node.right, checker))
    )
      issues.push({
        node,
        message: "compare stable state or identifiers instead of translated text",
      });
    ts.forEachChild(node, visit);
  };
  visit(source);
  return issues;
}

function textSinks(source: ts.SourceFile, checker: ts.TypeChecker): TextSink[] {
  const sinks: TextSink[] = [];
  const add = (expression: ts.Expression | undefined, reason: string) => {
    if (expression) sinks.push({ expression, reason });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (
        name &&
        (textProperties.has(name) ||
          (name === "name" && nativeFilterName(node)) ||
          (name === "value" && displayTableValue(node)) ||
          (displayTableValue(node) &&
            node.parent.parent.parent &&
            ts.isJsxAttribute(node.parent.parent.parent) &&
            node.parent.parent.parent.name.getText() === "values"))
      )
        add(node.initializer, `display property ${name}`);
    }
    if (
      (ts.isBindingElement(node) || ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      node.initializer
    ) {
      const name = propertyName(node.name);
      if (name && textProperties.has(name)) add(node.initializer, `display default ${name}`);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      textProperties.has(node.left.name.text)
    )
      add(node.right, `display assignment ${node.left.name.text}`);
    if (ts.isJsxAttribute(node) && node.initializer && isTextAttribute(node)) {
      add(
        ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : ts.isStringLiteral(node.initializer)
            ? node.initializer
            : undefined,
        "visible attribute",
      );
    }
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression.getText(source);
      const signature = checker.getResolvedSignature(node);
      const declaration = signature?.declaration;
      const declarationFile = declaration?.getSourceFile().fileName.replaceAll("\\", "/");
      node.arguments?.forEach((argument, index) => {
        const parameter = declaration?.parameters[index];
        const name = parameter && propertyName(parameter.name);
        const ownHelper = declarationFile?.includes("/src/");
        const errorFactory =
          signature &&
          /^(?:GitError|Error|never)$/.test(checker.typeToString(signature.getReturnType()));
        if (ownHelper && name === "message" && errorFactory)
          add(argument, "error message argument");
        if (
          ownHelper &&
          name &&
          (displayParameters.has(name) ||
            (name === "kind" &&
              /\/(?:operation-manager|repository-writer)\.ts$/.test(declarationFile!)))
        )
          add(argument, `display argument ${name}`);
        if (
          (messageSetters.has(callee) || ["Error", "TypeError", "RangeError"].includes(callee)) &&
          index === 0
        )
          add(argument, "display message argument");
        if (
          ["t", "errorText"].includes(callee) &&
          index === 1 &&
          ts.isObjectLiteralExpression(argument)
        ) {
          argument.properties.forEach((property) => {
            if (ts.isPropertyAssignment(property))
              add(property.initializer, "translation parameter");
          });
        }
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sinks;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log("Checking localization key order, usage, message formats, and application text.");
  const { files, localeCount, issues } = checkLocalization(process.cwd(), console);
  const total = files.reduce((count, file) => count + (file.keyCount ?? 0), 0);
  console.log(`Locales: ${localeCount} | Catalogs: ${files.length} | Keys: ${total}`);

  if (issues.length) {
    const count = issues.length === 1 ? "1 error" : `${issues.length} errors`;
    console.error(`Localization checks failed (${count}).`);
    process.exitCode = 1;
  } else {
    console.log("Localization checks passed.");
  }
}
