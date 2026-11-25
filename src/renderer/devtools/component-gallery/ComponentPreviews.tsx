import { LocalReferenceFeedback } from "../../features/references/LocalReferenceFeedback";
import type {
  DiffMode,
  HistoryCommit,
  RepositoryChange,
  UnifiedDiff,
} from "@shared/repository/repository-read";
import { t } from "@shared/i18n";
import { useState } from "react";
import type { RemoteChange } from "@shared/integrations/remotes";
import { RemoteConfiguration } from "../../features/sync/RemoteConfiguration";

import type { RebasePlanEntry } from "@shared/workflows/rebase";
import type { SshKey } from "@shared/identity/ssh";
import { layoutCommitPage } from "../../repository/dag-layout";
import { buildChangeTree } from "../../repository/change-tree";
import { ChangeRow, DirectoryRow } from "../../features/changes/ChangeRows";
import { DiffContent } from "../../features/diff/DiffContent";
import { CommitDetails } from "../../features/diff/CommitDetails";
import { CommitRow, WorkingTreeRow } from "../../features/history/CommitRow";
import { CollapsiblePanel } from "../../components/layout/CollapsiblePanel";
import {
  ViewTransition,
  RetainedView,
  LayoutTransition,
} from "../../components/layout/ViewTransition";
import { useViewTransition } from "../../components/layout/hooks/useViewTransition";
import { useLayoutTransition } from "../../components/layout/hooks/useLayoutTransition";
import { Split } from "../../components/layout/Split";
import type { PanelState } from "../../components/layout/PanelControls";
import { PanelHeader } from "../../components/layout/PanelHeader";
import { RebasePlanEditor } from "../../features/workflows/RebasePlanEditor";
import { SshKeyList } from "../../features/credentials/SshKeyList";
import { ThemePreferences } from "../../features/settings/appearance/ThemePreferences";
import { UpdateStatus } from "../../features/updates/UpdatesSettings";
import type { UpdatePhase, UpdateState } from "@shared/updates";
import { builtInSetting, type ThemePreference } from "@shared/preferences/settings";
import {
  Button,
  Checkbox,
  CodeBlock,
  CopyButton,
  SegmentedControl,
  Select,
  StateMessage,
} from "../../components/ui/index";

export function ThemesPreview() {
  const [theme, setTheme] = useState<ThemePreference>({
    ...builtInSetting("theme").value,
    mode: "dark",
  });

  return <ThemePreferences value={theme} onChange={setTheme} />;
}

export function RemotesPreview() {
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<RemoteChange>({ kind: "add", name: "origin", url: "" });

  return (
    <div className="space-y-4">
      <Checkbox checked={loading} onChange={(event) => setLoading(event.target.checked)}>
        {t("remotes.loading")}
      </Checkbox>
      <RemoteConfiguration
        remotes={[
          {
            name: "origin",
            fetchUrls: ["https://example.com/team/repo.git"],
            pushUrls: ["https://example.com/team/repo.git"],
          },
        ]}
        edit={edit}
        busy={false}
        loading={loading}
        onEdit={setEdit}
        onRemove={() => setEdit({ kind: "add", name: "", url: "" })}
        onSave={() => setEdit({ kind: "add", name: "", url: "" })}
      />
    </div>
  );
}

export function UpdatesPreview() {
  const [phase, setPhase] = useState<UpdatePhase>("available");
  const [homebrew, setHomebrew] = useState(false);

  const state: UpdateState = {
    revision: 0,
    capability: homebrew ? "homebrew" : "automatic",
    reason: null,
    phase,
    feedUrl: null,
    checkedAt: "2026-10-31T00:00:00.000Z",
    release: {
      version: "0.0.2",
      name: "Eda 0.0.2-012345abcdef",
      notes: t("settings.componentPreviews.exampleReleaseNotesThisPreviewNeverContactsThe"),
      releasedAt: null,
    },
    progress:
      phase === "downloading"
        ? {
            percent: 45,
            transferred: 45 * 1024 * 1024,
            total: 100 * 1024 * 1024,
            bytesPerSecond: 0,
          }
        : null,
    error:
      phase === "error"
        ? t("settings.componentPreviews.theUpdateServiceIsNotAvailableYetTryAgainLater")
        : null,
  };

  return (
    <div className="w-full space-y-4">
      <p className="text-xs text-text-tertiary">
        {t("settings.componentPreviews.localPreviewOnlyNoDownloadsOrInstallationsArePerformed")}
      </p>

      <Select
        aria-label={t("settings.stateSimulations.installationMethod")}
        value={homebrew ? "homebrew" : "direct"}
        onValueChange={(value) => {
          setHomebrew(value === "homebrew");
          setPhase("available");
        }}
      >
        <option value="direct">{t("settings.aboutSettings.installationDirect")}</option>
        <option value="homebrew">{t("settings.aboutSettings.installationHomebrew")}</option>
      </Select>

      <Select
        aria-label={t("settings.componentPreviews.updatePreviewState")}
        value={phase}
        onValueChange={(value) => setPhase(value as UpdatePhase)}
      >
        {(
          [
            "idle",
            "checking",
            "current",
            "available",
            "downloading",
            "ready",
            "installing",
            "error",
          ] as const
        )
          .filter((item) => !homebrew || !["downloading", "ready"].includes(item))
          .map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
      </Select>

      <UpdateStatus
        state={state}
        actions={{
          check: async () => {
            setPhase("current");
            return true;
          },
          download: async () => {
            setPhase("downloading");
            return true;
          },
          install: async () => {
            setPhase("installing");
            return true;
          },
        }}
      />

      {phase === "downloading" && (
        <Button onClick={() => setPhase("ready")}>
          {t("settings.componentPreviews.previewCompletedDownload")}
        </Button>
      )}
    </div>
  );
}

const SAMPLE_PLAN: RebasePlanEntry[] = [
  {
    oid: "a".repeat(40),
    action: "pick",
    message: t("settings.componentPreviews.addGreetingModule"),
  },
  {
    oid: "b".repeat(40),
    action: "reword",
    message: t("settings.componentPreviews.improveGreetingOutput"),
  },
  {
    oid: "c".repeat(40),
    action: "pick",
    message: t("settings.componentPreviews.fixupAddGreetingModule"),
  },
];

export function RebasePreview() {
  const [plan, setPlan] = useState(SAMPLE_PLAN);

  return (
    <RebasePlanEditor plan={plan} original={SAMPLE_PLAN} disabled={false} onChange={setPlan} />
  );
}

const SAMPLE_KEYS: SshKey[] = [
  {
    path: "~/.ssh/example_ed25519",
    type: "ED25519",
    bits: 256,
    fingerprint: "SHA256:ExampleFingerprintForTheComponentPreviewOnly",
    comment: t("settings.componentPreviews.workstationKey"),
    encrypted: true,
    loadedInAgent: true,
  },
  {
    path: "~/.ssh/example_rsa",
    type: "RSA",
    bits: 4096,
    fingerprint: "SHA256:AnotherExampleFingerprintForThePreviewOnly",
    comment: t("settings.componentPreviews.backupKey"),
    encrypted: true,
    loadedInAgent: false,
  },
];

export function KeysPreview() {
  const [assigned, setAssigned] = useState<string | undefined>(SAMPLE_KEYS[0]!.path);

  return (
    <SshKeyList
      keys={SAMPLE_KEYS}
      assignedPath={assigned}
      assigning={false}
      onAssign={(path) => setAssigned(path ?? undefined)}
    />
  );
}

const SAMPLE_CODE = `export function greeting(name: string) {
  const message = \`Hello, \${name}!\`;
  return message;
}

const outputPath = "workspace/repositories/example-project/src/components/settings/preview/generated/long-path-example.ts";`;

const SAMPLE_DIFF: UnifiedDiff = {
  files: [
    {
      oldPath: "src/greeting.ts",
      newPath: "src/greeting.ts",
      status: "modified",
      binary: false,
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          heading: t("settings.componentPreviews.greeting"),
          lines: [
            {
              type: "context",
              oldLineNumber: 1,
              newLineNumber: 1,
              content: "export function greeting(name: string) {",
            },
            { type: "deletion", oldLineNumber: 2, content: '  return "Hello " + name;' },
            { type: "addition", newLineNumber: 2, content: "  const message = `Hello, ${name}!`;" },
            { type: "addition", newLineNumber: 3, content: "  return message;" },
            { type: "context", oldLineNumber: 3, newLineNumber: 4, content: "}" },
          ],
        },
      ],
    },
    {
      oldPath: "assets/logo.png",
      newPath: "assets/logo.png",
      status: "modified",
      binary: true,
      hunks: [],
    },
    { oldPath: "README.old.md", newPath: "README.md", status: "renamed", binary: false, hunks: [] },
    {
      newPath: "logs/large-output.txt",
      status: "added",
      binary: false,
      truncated: true,
      hunks: [
        {
          oldStart: 0,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          heading: "",
          lines: [
            {
              type: "addition",
              newLineNumber: 1,
              content: t("settings.componentPreviews.largeFileExample"),
            },
          ],
        },
      ],
    },
  ],
};

export function CodePreview() {
  const [wrap, setWrap] = useState(false);

  return (
    <div className="space-y-4">
      <Checkbox checked={wrap} onChange={(event) => setWrap(event.target.checked)}>
        {t("settings.componentPreviews.wrapLongLines")}
      </Checkbox>
      <CodeBlock label={t("settings.componentPreviews.sourceCodeExample")} wrap={wrap}>
        {SAMPLE_CODE}
      </CodeBlock>
      <CopyButton value={SAMPLE_CODE} label={t("settings.componentPreviews.copySource")} />
      <p className="text-xs text-text-secondary">
        {t("settings.componentPreviews.focusTheBlockToScrollWithTheKeyboard")}
      </p>
      <CodeBlock label={t("settings.componentPreviews.commandOutputExample")} wrap>
        {t("settings.componentPreviews.fetchingOriginReceivingObjects1004242UpdatedOriginMainNo")}
      </CodeBlock>
    </div>
  );
}

export function DiffPreview() {
  const [mode, setMode] = useState<DiffMode>("unified");

  return (
    <div className="space-y-4">
      <SegmentedControl
        label={t("settings.componentPreviews.previewDiffLayout")}
        value={mode}
        options={[
          { value: "unified", label: t("settings.componentPreviews.unified") },
          { value: "split", label: t("settings.componentPreviews.sideBySide") },
        ]}
        onChange={setMode}
      />

      <div className="flex h-[360px] min-w-0 flex-col overflow-hidden rounded-md border border-border-default bg-bg-inset">
        <DiffContent key={mode} diff={SAMPLE_DIFF} mode={mode} readOnly />
      </div>
      <p className="text-xs text-text-secondary">
        {t("settings.componentPreviews.theApplicationSDiffRendererWithSampleText")}
      </p>
    </div>
  );
}

const CHANGES: RepositoryChange[] = [
  { kind: "ordinary", path: "src/greeting.ts", index: ".", worktree: "M", submodule: "N..." },
  { kind: "untracked", path: "src/new-file.ts", index: "?", worktree: "?", submodule: "N..." },
  { kind: "ordinary", path: "src/obsolete.ts", index: ".", worktree: "D", submodule: "N..." },
  {
    kind: "rename",
    path: "README.md",
    originalPath: "README.old.md",
    index: "R",
    worktree: ".",
    submodule: "N...",
  },
];

const COMMITS: HistoryCommit[] = [
  {
    oid: "a".repeat(40),
    parents: ["b".repeat(40)],
    author: {
      name: "Eda Example",
      email: "example@example.com",
      timestamp: "2026-01-15T10:00:00Z",
    },
    committerTimestamp: "2026-01-15T10:00:00Z",
    subject: t("settings.componentPreviews.improveGreetingOutput"),
    body: t(
      "settings.componentPreviews.improveGreetingOutputKeepTheInterfaceConsistentAndReadable",
    ),
    decorations: [
      { type: "head", name: "main" },
      { type: "tag", name: "v1.0" },
    ],
  },
  {
    oid: "b".repeat(40),
    parents: [],
    author: {
      name: "Eda Example",
      email: "example@example.com",
      timestamp: "2026-01-14T10:00:00Z",
    },
    committerTimestamp: "2026-01-14T10:00:00Z",
    subject: t("settings.componentPreviews.addGreetingModule"),
    body: "",
    decorations: [],
  },
];

export function RepositoryRowsPreview() {
  const [selected, setSelected] = useState(CHANGES[0]!.path);
  const [checked, setChecked] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [commit, setCommit] = useState(COMMITS[0]!);
  const [workingTitle, setWorkingTitle] = useState("");

  const [message, setMessage] = useState(
    t("settings.componentPreviews.interactionsOnlyUpdateThisPreview"),
  );

  const directory = buildChangeTree(CHANGES.filter((change) => change.path.startsWith("src/")))[0]!;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-md border border-border-default bg-bg-inset">
        <DirectoryRow
          node={directory}
          depth={0}
          collapsed={collapsed}
          writing={false}
          stageable
          staged={false}
          onToggle={() => setCollapsed(!collapsed)}
          onToggleStage={() =>
            setMessage(t("settings.componentPreviews.previewStageFolderSelected"))
          }
        />

        {CHANGES.filter((change) => !collapsed || !change.path.startsWith("src/")).map((change) => (
          <ChangeRow
            key={change.path}
            change={change}
            area={
              change.index === "R"
                ? "staged"
                : change.kind === "untracked"
                  ? "untracked"
                  : "unstaged"
            }
            depth={change.path.startsWith("src/") ? 1 : 0}
            showDirectory={false}
            selected={selected === change.path}
            writing={false}
            checked={checked.includes(change.path)}
            onCheck={() =>
              setChecked((values) =>
                values.includes(change.path)
                  ? values.filter((path) => path !== change.path)
                  : [...values, change.path],
              )
            }
            onSelect={() => setSelected(change.path)}
            onToggleStage={() =>
              setMessage(
                t("settings.componentPreviews.previewStageActionFor", { path: change.path }),
              )
            }
          />
        ))}
      </div>

      <div className="overflow-hidden rounded-md border border-border-default bg-bg-inset">
        <WorkingTreeRow
          title={workingTitle}
          titleDisabled={false}
          onTitleChange={setWorkingTitle}
          changes={CHANGES}
          truncated={false}
          gutter={40}
          lane={0}
          selected={false}
          onSelect={() =>
            setMessage(t("commitChangesPanel.workingTreeChanges", { count: CHANGES.length }))
          }
        />
        {layoutCommitPage(COMMITS).rows.map((row, index) => (
          <CommitRow
            key={row.commit.oid}
            row={row}
            columns={[{ id: "sha", visible: true, width: 80 }]}
            vigilantMode
            signature={{
              status: index === 0 ? "verified" : "unsigned",
              format: index === 0 ? "ssh" : null,
              reasonCode: null,
              diagnostics: "",
            }}
            gutter={40}
            selected={commit.oid === row.commit.oid}
            related={false}
            workingTreeConnection={index === 0 ? { lane: 0, head: true } : undefined}
            onSelect={() => setCommit(row.commit)}
            onContextMenu={(event) => event.preventDefault()}
          />
        ))}

        <CommitDetails
          commit={commit}
          inspection={{
            commit,
            containingRefs: ["refs/heads/main"],
            shallow: false,
            signed: false,
            signature: { status: "unsigned", format: null, reasonCode: null, diagnostics: "" },
          }}
          onSelectParent={(oid) => setCommit(COMMITS.find((item) => item.oid === oid) ?? commit)}
        />
      </div>

      <p role="status" className="text-xs text-text-secondary">
        {message}
      </p>
    </div>
  );
}

export function ViewTransitionPreview() {
  const navigation = useViewTransition();
  const [page, setPage] = useState(0);
  const [preset, setPreset] = useState<"section" | "navigation" | "layout">("section");

  return (
    <div className="space-y-3">
      <SegmentedControl
        label={t("settings.componentPreviews.motionPreset")}
        value={preset}
        options={[
          { value: "section", label: t("settings.componentPreviews.settingsSection") },
          { value: "navigation", label: t("settings.componentPreviews.onboardingStep") },
          { value: "layout", label: t("settings.componentPreviews.panelLayout") },
        ]}
        onChange={setPreset}
      />

      <Button
        onClick={() =>
          navigation.transition(
            () => setPage((value) => value + 1),
            preset === "navigation" ? (page % 2 === 0 ? "forward" : "back") : preset,
          )
        }
      >
        {t("settings.componentPreviews.previewViewTransition")}
      </Button>

      <ViewTransition
        ref={navigation.ref}
        className="rounded-md border border-border-subtle p-4 text-sm text-text-secondary"
      >
        <RetainedView active={page % 2 === 0}>
          <p>{t("settings.componentPreviews.workspaceViewRetainedWhileSettingsIsOpen")}</p>
        </RetainedView>
        {page % 2 !== 0 && <p>{t("settings.componentPreviews.settingsView")}</p>}
      </ViewTransition>

      <p className="text-xs text-text-tertiary">
        {t("settings.componentPreviews.settingsAndOnboardingShareTheSameSlideAnd")}
      </p>
    </div>
  );
}

export function LayoutPreview() {
  return (
    <LayoutTransition className="h-72 overflow-hidden rounded-md border border-border-default bg-bg-inset">
      <LayoutPreviewContent />
    </LayoutTransition>
  );
}

function LayoutPreviewContent() {
  const [state, setState] = useState<PanelState>("normal");
  const transition = useLayoutTransition();
  const change = (next: PanelState) => transition(() => setState(next));

  return (
    <>
      <Split
        direction="vertical"
        className="h-full"
        storageKey="gallery.panel-motion"
        persist={false}
        label={t("settings.componentPreviews.resizePreviewPanel")}
        defaultFraction={0.6}
        minFirst={80}
        minSecond={48}
        collapsed={state === "collapsed" ? "first" : state === "maximized" ? "second" : undefined}
        first={
          <CollapsiblePanel
            name={t("componentPreviews.previewPanel")}
            collapsed={state === "collapsed"}
            horizontal
            onExpand={() => change("normal")}
          >
            <PanelHeader
              title={t("settings.componentPreviews.previewPanel")}
              controls={{
                name: t("componentPreviews.previewPanelLabel"),
                state,
                onToggleCollapse: () => change("collapsed"),
                onToggleMaximize: () => change(state === "maximized" ? "normal" : "maximized"),
                collapseDirection: "down",
              }}
            />

            <p className="p-4 text-sm text-text-secondary">
              {t("settings.componentPreviews.collapseMaximizeRestoreOrResizeThisPanelIt")}
            </p>
          </CollapsiblePanel>
        }
        second={
          <CollapsiblePanel
            name={t("componentPreviews.adjacentPanel")}
            collapsed={state === "maximized"}
            horizontal
            onExpand={() => change("normal")}
          >
            <p className="p-4 text-sm text-text-secondary">
              {t("settings.componentPreviews.adjacentContentMovesWithThePanel")}
            </p>
          </CollapsiblePanel>
        }
      />
    </>
  );
}

export function StatesPreview() {
  const [tone, setTone] = useState<"empty" | "loading" | "error" | "success" | "info">("empty");

  const messages = {
    empty: t("settings.componentPreviews.noMatchingFiles"),
    loading: t("settings.componentPreviews.loadingChanges"),
    success: t("settings.componentPreviews.everythingIsUpToDate"),
    info: t("settings.componentPreviews.chooseARepository"),
  };

  return (
    <div className="space-y-4">
      <Select
        aria-label={t("settings.componentPreviews.previewMessageState")}
        value={tone}
        onValueChange={(value) => setTone(value as typeof tone)}
      >
        <option value="empty">{t("settings.componentPreviews.empty")}</option>
        <option value="loading">{t("settings.componentPreviews.loading")}</option>
        <option value="error">{t("settings.componentPreviews.error")}</option>
        <option value="success">{t("settings.componentPreviews.success")}</option>
        <option value="info">{t("settings.componentPreviews.information")}</option>
      </Select>

      <div className="rounded-md border border-border-subtle bg-bg-inset">
        {tone === "error" ? (
          <LocalReferenceFeedback
            loaded={false}
            empty={false}
            error={t(
              "settings.componentPreviews.theRepositoryIsTemporarilyUnavailableYourWorkingFilesAreUnchanged",
            )}
            retry={() => setTone("success")}
          />
        ) : (
          <StateMessage
            tone={tone}
            title={messages[tone]}
            description={
              tone === "empty"
                ? t("settings.componentPreviews.tryADifferentNameOrClearYourFilters")
                : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
