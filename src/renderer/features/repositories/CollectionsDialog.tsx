import { errorText } from "@shared/error-codes";
import { accentToHex } from "@shared/preferences/accent";
import { AppError, errorMessage, type Result } from "@shared/errors";
import { t } from "@shared/i18n";
import type { CollectionMember, LocalCollection } from "@shared/repository/collections";
import { useState } from "react";
import {
  Checkbox,
  Dialog,
  Field,
  Input,
  Select,
  StateMessage,
  TextButton,
} from "../../components/ui/index";
import { useRepositoryRead } from "../../repository/hooks/useRepositoryRead";
import { useAppStore } from "../../stores/app-store";

function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}
export function CollectionsDialog({
  profileId,
  onClose,
}: {
  profileId: string;
  onClose: () => void;
}) {
  const repos = useAppStore((s) => s.repositories);
  const { value, error, retry } = useRepositoryRead(
    (id: string) => window.eda.settings.resolve("localCollections", { profileId: id }),
    profileId,
  );
  const collections = value?.value;
  const [draft, setDraft] = useState<LocalCollection | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [hints, setHints] = useState(false);
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<string[]>([]);
  const current = () =>
    useAppStore.getState().activeIdentity?.id === profileId &&
    useAppStore.getState().switchingIdentityId === null;
  const perform = async (work: () => Promise<void>) => {
    if (busy || !current()) return;
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (failure) {
      setNotice(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const select = (item: LocalCollection | null) => {
    setDraft(item);
    setConfirm(false);
    setProgress([]);
    setNotice("");
  };
  const save = async (next: LocalCollection[]) => {
    if (!collections || !current()) return;
    unwrap(await window.eda.settings.saveCollections(profileId, collections, next));
    retry();
  };
  const storeDraft = async (item: LocalCollection) => {
    if (!collections) return;
    const exists = collections.some((c) => c.id === item.id);
    await save(
      exists ? collections.map((c) => (c.id === item.id ? item : c)) : [...collections, item],
    );
    setDraft(item);
  };
  const mapped = (m: CollectionMember) => repos.find((r) => r.id === m.repositoryId);
  const bulk = async (action: "open" | "fetch" | "pull" | "clone") => {
    if (!draft) return;
    const collection = { ...draft, members: [...draft.members] };
    let parent: string | null = null;
    if (action === "clone") {
      parent = unwrap(await window.eda.repository.chooseFolder());
      if (!parent) return;
    }
    const lines: string[] = [];
    for (const [i, member] of collection.members.entries()) {
      if (!current()) break;
      setProgress([...lines, member.name + " · " + t("collections.running")]);
      try {
        const local = mapped(member);
        let outcome = t("collections.done");
        if (action === "clone" && local?.available) outcome = t("collections.exists");
        else if (action === "clone" && member.remote && parent) {
          const repo = unwrap(
            await window.eda.remotes.clone({
              profileId,
              parent,
              name: member.name,
              url: member.remote,
            }),
          );
          collection.members[i] = { ...member, repositoryId: repo.id, pathHint: repo.path };
        } else if (!local?.available || action === "clone")
          throw new AppError(errorText("collections.missing"));
        else if (action === "fetch")
          unwrap(
            await window.eda.remotes.fetch({
              repositoryId: local.id,
              remote: null,
              prune: false,
              tags: false,
            }),
          );
        else if (action === "pull") {
          const preview = unwrap(
            await window.eda.pull.prepare({ repositoryId: local.id, strategy: "ff-only" }),
          );
          if (preview.blockedReason)
            throw new AppError(
              errorText("errors.operationBlocked", { reason: preview.blockedReason }),
            );
          if (current()) unwrap(await window.eda.pull.execute(local.id, preview.token));
        } else useAppStore.getState().selectRepository(local.id, true);
        lines.push(member.name + " · " + outcome);
      } catch (failure) {
        lines.push(member.name + " · " + errorMessage(failure));
      }
      setProgress([...lines]);
    }
    if (action === "clone" && current()) {
      await useAppStore.getState().refreshRepositories();
      setDraft(collection);
      await storeDraft(collection);
    }
  };
  return (
    <Dialog title={t("collections.title")} onClose={onClose} busy={busy} wide>
      {error && (
        <StateMessage
          tone="error"
          title={error}
          action={<TextButton onClick={retry}>{t("common.retry")}</TextButton>}
        />
      )}
      {!collections && !error && <StateMessage tone="loading" title={t("collections.title")} />}
      {notice && <p role="alert">{notice}</p>}
      {collections && (
        <div className="space-y-3">
          <Field label={t("collections.search")}>
            {(field) => (
              <Input {...field} value={query} onChange={(e) => setQuery(e.target.value)} />
            )}
          </Field>
          <div className="flex flex-wrap gap-2">
            {collections
              .filter((c) =>
                (c.name + " " + c.description).toLowerCase().includes(query.toLowerCase()),
              )
              .map((c) => (
                <TextButton key={c.id} disabled={busy} onClick={() => select(c)}>
                  <span style={{ color: c.color }}>{c.icon}</span> {c.name}
                </TextButton>
              ))}
          </div>
          <TextButton
            disabled={busy}
            onClick={() =>
              select({
                id: crypto.randomUUID(),
                name: "",
                description: "",
                color: accentToHex(useAppStore.getState().activeIdentity?.hue ?? 210),
                icon: "●",
                members: [],
              })
            }
          >
            {t("collections.new")}
          </TextButton>
          <TextButton
            disabled={busy}
            onClick={() =>
              void perform(async () => {
                const c = unwrap(await window.eda.settings.collectionManifest(profileId));
                if (c) select(c);
              })
            }
          >
            {t("collections.import")}
          </TextButton>
          {draft && (
            <fieldset disabled={busy} className="space-y-2">
              {(["name", "description", "icon", "color"] as const).map((key) => (
                <Field key={key} label={t(`collections.${key}`)}>
                  {(field) => (
                    <Input
                      {...field}
                      type={key === "color" ? "color" : "text"}
                      value={draft[key]}
                      maxLength={key === "name" ? 100 : key === "icon" ? 8 : 500}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
              <strong>{t("collections.members")}</strong>
              {repos.map((repo) => (
                <Checkbox
                  key={repo.id}
                  checked={draft.members.some((m) => m.repositoryId === repo.id)}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      members: e.target.checked
                        ? [
                            ...draft.members,
                            { name: repo.name, repositoryId: repo.id, pathHint: repo.path },
                          ]
                        : draft.members.filter((m) => m.repositoryId !== repo.id),
                    })
                  }
                >
                  {repo.name}
                </Checkbox>
              ))}
              {draft.members.map(
                (m, i) =>
                  !mapped(m) && (
                    <Field
                      key={i}
                      label={m.name + " · " + (m.remote ?? m.pathHint ?? t("collections.local"))}
                    >
                      {(field) => (
                        <Select
                          {...field}
                          value=""
                          onValueChange={(id) =>
                            setDraft({
                              ...draft,
                              members: draft.members.map((member, index) =>
                                index === i ? { ...member, repositoryId: id } : member,
                              ),
                            })
                          }
                        >
                          <option value="">{t("collections.unmapped")}</option>
                          {repos
                            .filter(
                              (r) => !draft.members.some((member) => member.repositoryId === r.id),
                            )
                            .map((r) => (
                              <option key={r.id} value={r.id}>
                                {r.path}
                              </option>
                            ))}
                        </Select>
                      )}
                    </Field>
                  ),
              )}
              <div className="flex flex-wrap gap-2">
                <TextButton
                  disabled={!draft.name.trim()}
                  onClick={() => void perform(() => storeDraft(draft))}
                >
                  {t("collections.save")}
                </TextButton>
                {([-1, 1] as const).map((step) => {
                  const i = collections.findIndex((c) => c.id === draft.id);
                  return (
                    <TextButton
                      key={step}
                      disabled={i < 0 || !collections[i + step]}
                      onClick={() =>
                        void perform(async () => {
                          const next = [...collections];
                          next[i] = next[i + step]!;
                          next[i + step] = draft;
                          await save(next);
                        })
                      }
                    >
                      {t(step < 0 ? "collections.up" : "collections.down")}
                    </TextButton>
                  );
                })}
                <TextButton
                  onClick={() => {
                    if (!confirm) setConfirm(true);
                    else
                      void perform(async () => {
                        await save(collections.filter((c) => c.id !== draft.id));
                        select(null);
                      });
                  }}
                >
                  {t(confirm ? "collections.confirmDelete" : "collections.delete")}
                </TextButton>
              </div>
              <Checkbox checked={hints} onChange={(e) => setHints(e.target.checked)}>
                {t("collections.hints")}
              </Checkbox>
              <TextButton
                disabled={!draft.name.trim()}
                onClick={() =>
                  void perform(async () => {
                    unwrap(await window.eda.settings.collectionManifest(profileId, draft, hints));
                  })
                }
              >
                {t("collections.export")}
              </TextButton>
              <div className="flex flex-wrap gap-2">
                {(["open", "fetch", "pull", "clone"] as const).map((action) => (
                  <TextButton
                    key={action}
                    disabled={!draft.members.length || !draft.name.trim()}
                    onClick={() => void perform(() => bulk(action))}
                  >
                    {t(`collections.${action}`)}
                  </TextButton>
                ))}
              </div>
            </fieldset>
          )}
          <ul role="status">
            {progress.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
